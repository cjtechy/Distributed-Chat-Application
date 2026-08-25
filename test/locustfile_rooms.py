"""
Load test groups and DMs (not everyone in Community / group 1).

From the repo root:
  WS_HOST=ws://127.0.0.1:8080 LOAD_AUTH_MODE=token LOAD_TOKEN_FILE=test/.load-tokens.json \\
    locust -f test/locustfile_rooms.py --host=http://127.0.0.1:8000 --headless -u 400 -r 10 -t 120s

Modes (LOAD_ROOM_MODE):
  groups  — N rooms (LOAD_GROUP_COUNT), users join room i % N then chat/type
  direct  — pair users (0-1, 2-3, …) on POST /direct then chat/type
  mixed   — half groups, half DMs (default)
"""

from __future__ import annotations

import json
import os
import random
import string
import threading
import time

import requests
from locust import User, between, events, task
from websocket import WebSocketConnectionClosedException, create_connection

_user_id_lock = threading.Lock()
_next_user_id = 0
_token_pool: list[tuple[str, str]] | None = None
_slot_names: dict[int, str] = {}
_room_ids: dict[int, int] = {}
_room_lock = threading.Lock()
_direct_pair_lock = threading.Lock()
_direct_pair_names: dict[int, str] = {}
_next_direct_slot = 0


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _room_mode() -> str:
    mode = os.getenv("LOAD_ROOM_MODE", "mixed").lower()
    if mode in ("groups", "direct", "mixed"):
        return mode
    return "mixed"


def _group_count() -> int:
    return max(1, _env_int("LOAD_GROUP_COUNT", 20))


def _auth_mode() -> str:
    mode = os.getenv("LOAD_AUTH_MODE", "").lower()
    if mode:
        return mode
    if os.getenv("LOAD_TOKEN_FILE"):
        return "token"
    return "register"


def _load_token_pool() -> list[tuple[str, str]]:
    global _token_pool
    if _token_pool is not None:
        return _token_pool
    token_file = os.getenv("LOAD_TOKEN_FILE")
    if not token_file:
        raise RuntimeError("LOAD_TOKEN_FILE is required for token auth")
    with open(token_file, encoding="utf-8") as handle:
        data = json.load(handle)
    users = data.get("users", [])
    if not users:
        raise RuntimeError(f"No users in {token_file}")
    _token_pool = [(entry["username"], entry["token"]) for entry in users]
    return _token_pool


def _take_slot() -> int:
    global _next_user_id
    with _user_id_lock:
        slot = _next_user_id
        _next_user_id += 1
        return slot


def _credentials(host: str) -> tuple[int, str, str]:
    slot = _take_slot()
    if _auth_mode() == "token":
        pool = _load_token_pool()
        username, token = pool[slot % len(pool)]
        _slot_names[slot] = username
        return slot, username, token

    password = os.getenv("LOAD_PASSWORD", "loadpass123")
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    username = f"room_{suffix}"
    timeout = _env_int("LOAD_REGISTER_TIMEOUT", 120)
    response = requests.post(
        f"{host}/v1/register",
        json={"username": username, "password": password},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"register failed: {response.status_code} {response.text}")
    token = response.json()["access_token"]
    _slot_names[slot] = username
    return slot, username, token


def _direct_pair_slot(username: str) -> int:
    global _next_direct_slot
    with _direct_pair_lock:
        slot = _next_direct_slot
        _next_direct_slot += 1
        _direct_pair_names[slot] = username
        return slot


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _wait_direct_partner(slot: int, me: str, timeout_sec: float = 60.0) -> str:
    partner_slot = slot ^ 1
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        other = _direct_pair_names.get(partner_slot)
        if other and other != me:
            return other
        time.sleep(0.05)
    raise RuntimeError(f"DM partner for slot {slot} never appeared")


def _ensure_group(host: str, token: str, room_index: int) -> int:
    with _room_lock:
        existing = _room_ids.get(room_index)
        if existing:
            group_id = existing
        else:
            response = requests.post(
                f"{host}/v1/groups",
                json={"name": f"loadroom{room_index:03d}"},
                headers=_headers(token),
                timeout=30,
            )
            if response.status_code != 200:
                raise RuntimeError(f"create group failed: {response.status_code} {response.text}")
            group_id = int(response.json()["id"])
            _room_ids[room_index] = group_id

    join = requests.post(
        f"{host}/v1/groups/{group_id}/join",
        headers=_headers(token),
        timeout=30,
    )
    if join.status_code not in (200, 400, 403):
        raise RuntimeError(f"join group failed: {join.status_code} {join.text}")
    return group_id


def _ensure_direct(host: str, token: str, me: str, other: str) -> int:
    response = requests.post(
        f"{host}/v1/direct",
        json={"username": other},
        headers=_headers(token),
        timeout=30,
    )
    if response.status_code != 200:
        raise RuntimeError(f"direct failed: {response.status_code} {response.text}")
    return int(response.json()["id"])


def _open_socket(group_id: int, token: str):
    ws_host = os.getenv("WS_HOST", "ws://127.0.0.1:8080").rstrip("/")
    ws = create_connection(f"{ws_host}/v1/ws?group={group_id}", timeout=_env_int("LOAD_WS_CONNECT_TIMEOUT", 30))
    ws.send(json.dumps({"type": "auth", "token": token}))
    ws.recv()
    return ws


class RoomUser(User):
    """One WebSocket in either a load group or a DM."""

    wait_time = between(3, 8)
    abstract = True
    kind = "group"

    def on_start(self):
        start = time.time()
        name = f"/v1/ws {self.kind} connect"
        try:
            self.slot, self.username, self.token = _credentials(self.environment.host)
            self.group_id = self._pick_room()
            self.ws = _open_socket(self.group_id, self.token)
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=None,
            )
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )
            raise

    def _pick_room(self) -> int:
        raise NotImplementedError

    def on_stop(self):
        ws = getattr(self, "ws", None)
        if ws:
            try:
                ws.close()
            except Exception:
                pass

    @task(4)
    def send_message(self):
        start = time.time()
        payload = json.dumps({"message": f"{self.kind} from {self.username}"})
        name = f"/v1/ws {self.kind} send"
        try:
            self.ws.send(payload)
            self.ws.recv()
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=len(payload),
                exception=None,
            )
        except (WebSocketConnectionClosedException, OSError) as exc:
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )
            raise
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )

    @task(1)
    def send_typing(self):
        start = time.time()
        payload = json.dumps({"type": "typing"})
        name = f"/v1/ws {self.kind} typing"
        try:
            self.ws.send(payload)
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=len(payload),
                exception=None,
            )
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name=name,
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )


class GroupRoomUser(RoomUser):
    kind = "group"
    weight = 0 if _room_mode() == "direct" else 1

    def _pick_room(self) -> int:
        room_index = self.slot % _group_count()
        return _ensure_group(self.environment.host, self.token, room_index)


class DirectRoomUser(RoomUser):
    kind = "direct"
    weight = 0 if _room_mode() == "groups" else 1

    def _pick_room(self) -> int:
        pair_slot = _direct_pair_slot(self.username)
        other = _wait_direct_partner(pair_slot, self.username)
        return _ensure_direct(self.environment.host, self.token, self.username, other)
