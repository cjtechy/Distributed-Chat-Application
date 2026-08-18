# Erlang/OTP messaging service

Separate WebSocket process for live chat. FastAPI stays the HTTP/auth/Postgres service; this node owns concurrent connections.

```
Frontend --HTTP--> FastAPI --> PostgreSQL
                \              Redis Pub/Sub
Frontend --WS---> Erlang/OTP ----^
```

- Incoming chat text is published to Redis `chat:inbound`.
- FastAPI persists it (batched) and republishes on `chat:messages` with a database id.
- This node fans `chat:messages` out to local WebSocket clients.
- Typing / online / offline events go directly to `chat:messages` (no Postgres).

## Run

Install [Erlang/OTP 26+](https://www.erlang.org/downloads) and [rebar3](https://rebar3.org/).

From the repo root (loads `SECRET_KEY` / Redis settings from `backend/.env`):

```powershell
.\erlang-messaging\start.ps1
```

Health check: [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

Then point the frontend at this node:

```javascript
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  WS_BASE: "ws://127.0.0.1:8080/v1",
};
```

If `WS_BASE` is omitted, the browser keeps using FastAPI's WebSocket endpoint.
