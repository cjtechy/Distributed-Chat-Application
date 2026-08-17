"""
Load test the REST API with Locust.

Run from the backend folder:
  pip install -r requirements-dev.txt
  locust -f locustfile.py --host=http://127.0.0.1:8000

Adaptive ramp (increases load while API stays healthy, up to 100k users):
  locust -f locustfile.py --host=http://127.0.0.1:8000 --headless
  ..\\load-tests\\adaptive-load.ps1
"""

import json
import os
import random
import string
import time

import requests
from locust import HttpUser, LoadTestShape, User, between, events, task
from websocket import WebSocketConnectionClosedException, create_connection


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
    spawn_rate = _env_int("LOAD_SPAWN_RATE", 100)
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
        stats = self.runner.stats.total
        if stats.num_requests == 0:
            return 0.0, 0.0
        p95 = stats.get_response_time_percentile(0.95) or 0.0
        fail_ratio = stats.num_failures / stats.num_requests
        return p95, fail_ratio

    def _log(self, message: str):
        run_time = int(self.get_run_time())
        if run_time != self._last_log_second:
            self._last_log_second = run_time
            print(message, flush=True)

    def tick(self):
        run_time = self.get_run_time()
        if run_time > self.max_runtime:
            self._log(f"[adaptive] Max runtime {self.max_runtime}s reached — stopping.")
            return None

        if self._target_users < self.min_users:
            self._target_users = self.min_users

        current = self.runner.user_count
        stats = self.runner.stats.total
        p95, fail_ratio = self._metrics()

        if stats.num_requests >= self.min_requests:
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
                return self._target_users, 0

            if self._holding:
                if self._hold_ticks_left > 0:
                    self._hold_ticks_left -= 1
                    return self._target_users, 0
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
            return self._target_users, 0

        if not self._holding:
            step = self._step_size()
            self._target_users = min(self._target_users + step, self.max_users)
            if int(run_time) % 5 == 0:
                self._log(
                    f"[adaptive] target={self._target_users} current={current} "
                    f"spawn_rate={self.spawn_rate}/s p95={p95:.0f}ms failures={fail_ratio:.1%}"
                )

        rate = self.spawn_rate if not self._holding else 0
        return self._target_users, rate


def _random_username(prefix: str) -> str:
    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}_{suffix}"


class ChatHttpUser(HttpUser):
    """Simulates users hitting REST endpoints."""

    wait_time = between(1, 3)
    token: str | None = None
    auth_headers: dict[str, str] = {}

    def on_start(self):
        username = _random_username("load")
        password = "loadpass123"

        with self.client.post(
            "/v1/register",
            json={"username": username, "password": password},
            catch_response=True,
            name="/v1/register",
        ) as response:
            if response.status_code != 200:
                response.failure(f"register failed: {response.status_code} {response.text}")
                return

            data = response.json()
            self.token = data["access_token"]
            self.auth_headers = {"Authorization": f"Bearer {self.token}"}
            response.success()

    @task(5)
    def get_messages(self):
        if not self.token:
            return
        self.client.get("/v1/messages", headers=self.auth_headers, name="/v1/messages")

    @task(2)
    def get_online(self):
        self.client.get("/v1/online", name="/v1/online")

    @task(2)
    def get_status(self):
        self.client.get("/v1/status", name="/v1/status")

    @task(1)
    def get_me(self):
        if not self.token:
            return
        self.client.get("/v1/me", headers=self.auth_headers, name="/v1/me")


class ChatWebSocketUser(User):
    """Simulates users connected over WebSocket sending chat messages."""

    wait_time = between(3, 8)

    def on_start(self):
        host = self.environment.host
        username = _random_username("ws")
        password = "loadpass123"

        response = requests.post(
            f"{host}/v1/register",
            json={"username": username, "password": password},
            timeout=10,
        )
        if response.status_code != 200:
            raise RuntimeError(f"register failed: {response.status_code} {response.text}")

        self.username = username
        self.token = response.json()["access_token"]
        ws_host = host.replace("http://", "ws://").replace("https://", "wss://")
        self.ws_url = f"{ws_host}/v1/ws?token={self.token}"

        start = time.time()
        try:
            self.ws = create_connection(self.ws_url, timeout=10)
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
