"""
Load test the REST API with Locust.

Run from the repo root (Erlang must be running on WS_HOST, default ws://127.0.0.1:8080):
  pip install -r test/requirements.txt
  locust -f test/locustfile.py --host=http://127.0.0.1:8000
  WS_HOST=ws://127.0.0.1:8080 locust -f test/locustfile.py --host=http://127.0.0.1:8000 --headless
"""

import json
import os
import random
import string
import threading
import time

import requests
from locust import HttpUser, LoadTestShape, User, between, events, task
from websocket import WebSocketConnectionClosedException, create_connection

LOAD_WS_ONLY = os.getenv("LOAD_WS_ONLY", "").lower() in ("1", "true", "yes")
_user_id_lock = threading.Lock()
_next_user_id = 0
_token_pool: list[tuple[str, str]] | None = None


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, str(default)))


class AdaptiveLoadShape(LoadTestShape):
    """
    Ramps concurrent users while latency and error rate stay within limits.
    Holds when the API degrades, then retries the ramp after a recovery window.
    """

    min_users = _env_int("LOAD_START_USERS", 10)
    max_users = _env_int("LOAD_MAX_USERS", 100_000)
    spawn_rate = _env_int("LOAD_SPAWN_RATE", 5)
    max_p95_ms = _env_float("LOAD_MAX_P95_MS", 500)
    max_fail_ratio = _env_float("LOAD_MAX_FAIL_RATIO", 0.02)
    min_requests = _env_int("LOAD_MIN_REQUESTS", 50)
    recovery_ticks = _env_int("LOAD_RECOVERY_TICKS", 15)
    max_runtime = _env_int("LOAD_MAX_RUNTIME_SEC", 3600)
    step_users = _env_int("LOAD_STEP_USERS", 0)

    _target_users = 0
    _holding = False
    _hold_ticks_left = 0
    _last_log_second = -1

    def _step_size(self) -> int:
        return self.step_users if self.step_users > 0 else self.spawn_rate

    def _metrics(self):
        stats = self.runner.stats
        total_requests = 0
        total_failures = 0
        p95_values: list[float] = []

        for entry in stats.entries.values():
            if entry.name in ("/v1/register", "/v1/login"):
                continue
            total_requests += entry.num_requests
            total_failures += entry.num_failures
            if entry.num_requests:
                p95_values.append(entry.get_response_time_percentile(0.95) or 0.0)

        if total_requests == 0:
            return 0.0, 0.0, 0

        p95 = max(p95_values) if p95_values else 0.0
        fail_ratio = total_failures / total_requests
        return p95, fail_ratio, total_requests

    def _spawn_rate(self, holding: bool) -> float:
        # Locust crashes on spawn_rate=0 (ZeroDivisionError). Use 1 when holding steady.
        return 1 if holding else self.spawn_rate

    def _log(self, message: str):
        run_time = int(self.get_run_time())
        if run_time != self._last_log_second:
            self._last_log_second = run_time
            print(message, flush=True)

    def tick(self):
        run_time = self.get_run_time()
        if run_time > self.max_runtime:
            self._log(f"[adaptive] Max runtime {self.max_runtime}s reached - stopping.")
            return None

        if self._target_users < self.min_users:
            self._target_users = self.min_users

        current = self.runner.user_count
        p95, fail_ratio, chat_requests = self._metrics()

        if chat_requests >= self.min_requests:
            healthy = p95 <= self.max_p95_ms and fail_ratio <= self.max_fail_ratio

            if not healthy:
                if not self._holding:
                    self._log(
                        f"[adaptive] Slowdown — p95={p95:.0f}ms failures={fail_ratio:.1%}. "
                        f"Holding at ~{current} users for {self.recovery_ticks}s."
                    )
                self._holding = True
                self._hold_ticks_left = self.recovery_ticks
                self._target_users = max(current, self.min_users)
                return self._target_users, self._spawn_rate(holding=True)

            if self._holding:
                if self._hold_ticks_left > 0:
                    self._hold_ticks_left -= 1
                    return self._target_users, self._spawn_rate(holding=True)
                self._holding = False
                self._log(
                    f"[adaptive] Recovered — p95={p95:.0f}ms failures={fail_ratio:.1%}. Ramping again."
                )

        if self._target_users >= self.max_users:
            if int(run_time) % 10 == 0:
                self._log(
                    f"[adaptive] At max users ({self.max_users}). "
                    f"current={current} p95={p95:.0f}ms failures={fail_ratio:.1%}"
                )
            return self._target_users, self._spawn_rate(holding=True)

        if not self._holding:
            step = self._step_size()
            self._target_users = min(self._target_users + step, self.max_users)
            if int(run_time) % 5 == 0:
                self._log(
                    f"[adaptive] target={self._target_users} current={current} "
                    f"spawn_rate={self.spawn_rate}/s p95={p95:.0f}ms failures={fail_ratio:.1%}"
                )

        rate = self._spawn_rate(holding=self._holding)
        return self._target_users, rate


def _register_timeout() -> int:
    return _env_int("LOAD_REGISTER_TIMEOUT", 30)


def _login_timeout() -> int:
    return _env_int("LOAD_LOGIN_TIMEOUT", 30)


def _ws_connect_timeout() -> int:
    return _env_int("LOAD_WS_CONNECT_TIMEOUT", 30)


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
        raise RuntimeError("LOAD_TOKEN_FILE is required for token auth mode")

    with open(token_file, encoding="utf-8") as handle:
        data = json.load(handle)

    users = data.get("users", [])
    if not users:
        raise RuntimeError(f"No users found in token file: {token_file}")

    _token_pool = [(entry["username"], entry["token"]) for entry in users]
    return _token_pool


def _next_pool_credentials() -> tuple[str, str]:
    global _next_user_id
    pool = _load_token_pool()
    with _user_id_lock:
        uid = _next_user_id % len(pool)
        _next_user_id += 1
    return pool[uid]


def _load_password() -> str:
    return os.getenv("LOAD_PASSWORD", "loadpass123")


def _load_user_prefix() -> str:
    return os.getenv("LOAD_USER_PREFIX", "load_ws")


def _load_user_count() -> int:
    return _env_int("LOAD_USER_COUNT", 1000)


def _next_pool_username() -> str:
    global _next_user_id
    with _user_id_lock:
        uid = _next_user_id % _load_user_count()
        _next_user_id += 1
    return f"{_load_user_prefix()}_{uid:04d}"


def _pick_username(prefix: str) -> str:
    if _auth_mode() in ("login", "token"):
        return _next_pool_username()
    return _random_username(prefix)


def _random_username(prefix: str) -> str:
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{suffix}"


def _http_auth(client, prefix: str) -> tuple[str | None, str | None]:
    password = _load_password()
    username = _pick_username(prefix)
    path = "/v1/login" if _auth_mode() == "login" else "/v1/register"
    timeout = _register_timeout() if _auth_mode() == "register" else _login_timeout()

    with client.post(
        path,
        json={"username": username, "password": password},
        catch_response=True,
        name=path,
        timeout=timeout,
    ) as response:
        if response.status_code != 200:
            response.failure(f"{path} failed: {response.status_code} {response.text}")
            return None, None

        data = response.json()
        response.success()
        return username, data["access_token"]


def _ws_credentials(host: str) -> tuple[str, str]:
    if _auth_mode() == "token":
        return _next_pool_credentials()

    password = _load_password()
    username = _pick_username("ws")
    path = "/v1/login" if _auth_mode() == "login" else "/v1/register"
    timeout = _register_timeout() if _auth_mode() == "register" else _login_timeout()

    response = requests.post(
        f"{host}{path}",
        json={"username": username, "password": password},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"{path} failed: {response.status_code} {response.text}")

    return username, response.json()["access_token"]


class ChatHttpUser(HttpUser):
    """Simulates users hitting REST endpoints."""

    weight = 0 if LOAD_WS_ONLY else _env_int("LOAD_HTTP_WEIGHT", 1)
    wait_time = between(1, 3)
    token: str | None = None
    auth_headers: dict[str, str] = {}

    def on_start(self):
        username, token = _http_auth(self.client, "load")
        if not token:
            return

        self.token = token
        self.auth_headers = {"Authorization": f"Bearer {token}"}

    @task(5)
    def get_messages(self):
        if not self.token:
            return
        self.client.get("/v1/messages", headers=self.auth_headers, name="/v1/messages")

    @task(2)
    def get_online(self):
        if not self.token:
            return
        self.client.get("/v1/online", headers=self.auth_headers, name="/v1/online")

    @task(2)
    def get_status(self):
        if not self.token:
            return
        self.client.get("/v1/status", headers=self.auth_headers, name="/v1/status")

    @task(1)
    def get_me(self):
        if not self.token:
            return
        self.client.get("/v1/me", headers=self.auth_headers, name="/v1/me")


class ChatWebSocketUser(User):
    """Simulates users connected over WebSocket sending chat messages."""

    weight = _env_int("LOAD_WS_WEIGHT", 1)
    wait_time = between(3, 8)

    def on_start(self):
        start = time.time()
        try:
            self.username, self.token = _ws_credentials(self.environment.host)
            ws_host = os.getenv("WS_HOST", "ws://127.0.0.1:8080").rstrip("/")
            self.ws_url = f"{ws_host}/v1/ws?group=1"

            self.ws = create_connection(self.ws_url, timeout=_ws_connect_timeout())
            self.ws.send(json.dumps({"type": "auth", "token": self.token}))
            self.ws.recv()
            events.request.fire(
                request_type="WS",
                name="/v1/ws connect",
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=None,
            )
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name="/v1/ws connect",
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )
            raise

    def on_stop(self):
        if hasattr(self, "ws"):
            try:
                self.ws.close()
            except Exception:
                pass

    @task(4)
    def send_message(self):
        start = time.time()
        payload = json.dumps({"message": f"load test from {self.username}"})
        try:
            self.ws.send(payload)
            self.ws.recv()
            events.request.fire(
                request_type="WS",
                name="/v1/ws send",
                response_time=(time.time() - start) * 1000,
                response_length=len(payload),
                exception=None,
            )
        except WebSocketConnectionClosedException as exc:
            events.request.fire(
                request_type="WS",
                name="/v1/ws send",
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )
            raise
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name="/v1/ws send",
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )

    @task(1)
    def send_typing(self):
        start = time.time()
        payload = json.dumps({"type": "typing"})
        try:
            self.ws.send(payload)
            events.request.fire(
                request_type="WS",
                name="/v1/ws typing",
                response_time=(time.time() - start) * 1000,
                response_length=len(payload),
                exception=None,
            )
        except Exception as exc:
            events.request.fire(
                request_type="WS",
                name="/v1/ws typing",
                response_time=(time.time() - start) * 1000,
                response_length=0,
                exception=exc,
            )
