/**
 * WebSocket load test for the chat API (k6).
 *
 * Install k6: https://k6.io/docs/get-started/installation/
 *
 * Run:
 *   k6 run load-tests/ws-load.js
 *
 * Override base URL:
 *   k6 run -e BASE_URL=http://127.0.0.1:8000 load-tests/ws-load.js
 */

import { check, sleep } from "k6";
import http from "k6/http";
import ws from "k6/ws";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8000";
const WS_URL = BASE_URL.replace(/^http/, "ws");

export const options = {
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 50 },
    { duration: "2m", target: 50 },
    { duration: "30s", target: 100 },
    { duration: "2m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    ws_connecting: ["p(95)<1000"],
    checks: ["rate>0.95"],
  },
};

function registerUser() {
  const username = `k6_${__VU}_${__ITER}_${Date.now()}`;
  const payload = JSON.stringify({
    username,
    password: "loadpass123",
  });

  const response = http.post(`${BASE_URL}/v1/register`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "/v1/register" },
  });

  check(response, {
    "register status 200": (r) => r.status === 200,
    "register has token": (r) => r.json("access_token") !== undefined,
  });

  return {
    username,
    token: response.json("access_token"),
  };
}

export default function () {
  const user = registerUser();
  if (!user.token) {
    return;
  }

  const url = `${WS_URL}/v1/ws?token=${encodeURIComponent(user.token)}`;

  const response = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ message: `hello from ${user.username}` }));
    });

    socket.on("message", (data) => {
      check(data, {
        "received websocket payload": (payload) => payload && payload.length > 0,
      });
    });

    socket.on("error", (e) => {
      console.error(`websocket error: ${e.error()}`);
    });

    socket.setTimeout(() => {
      socket.send(JSON.stringify({ type: "typing" }));
    }, 2000);

    socket.setTimeout(() => {
      socket.send(JSON.stringify({ message: `follow-up from ${user.username}` }));
    }, 5000);

    socket.setTimeout(() => {
      socket.close();
    }, 15000);
  });

  check(response, {
    "websocket upgrade 101": (r) => r && r.status === 101,
  });

  sleep(1);
}
