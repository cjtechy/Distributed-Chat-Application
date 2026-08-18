# Erlang/OTP messaging service

WebSocket process for live chat. FastAPI handles HTTP, auth, and Postgres; this node owns all WebSocket connections.

```
Frontend --HTTP--> FastAPI --> PostgreSQL
                \              Redis Pub/Sub
Frontend --WS---> Erlang/OTP ----^
```

- Incoming chat text is published to Redis `chat:inbound` (HMAC-signed).
- FastAPI persists it (batched) and republishes on `chat:messages` with a database id (also signed).
- This node verifies signatures, then fans `chat:messages` out to local WebSocket clients.
- Typing / online / offline events go directly to `chat:messages` (no Postgres).
- Clients authenticate with a first-frame `{"type":"auth","ticket"|"token":...}` after `GET /v1/ws-ticket`.

## Configuration

Install [Erlang/OTP 26+](https://www.erlang.org/downloads) and [rebar3](https://rebar3.org/).

**All settings come from `backend/.env`** — the same file FastAPI uses. No separate Erlang config file and no hardcoded defaults in the BEAM code.

Required keys (see `backend/.env.example`):

| Variable | Used for |
|----------|----------|
| `SECRET_KEY` | JWT verification (must match FastAPI) |
| `ERLANG_WS_PORT` | Cowboy listen port |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_PASSWORD` | Redis connection |
| `REDIS_CHAT_CHANNEL`, `REDIS_INBOUND_CHANNEL`, `REDIS_ONLINE_KEY` | Pub/Sub channels |

Shell environment variables override values from the file. Set `DOTENV_PATH` to point at a different `.env` file.

## Run

Install [Erlang/OTP 26+](https://www.erlang.org/downloads) first. On Windows:

```powershell
winget install Erlang.Erlang
```

Close and reopen PowerShell after install. `start.ps1` downloads a local copy of rebar3 automatically — you do not need to install rebar3 globally.

Start FastAPI first, then from the repo root:

```powershell
.\erlang-messaging\start.ps1
```

Health check: [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

The frontend connects here via `WS_BASE` in `frontend/config.js`:

```javascript
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  WS_BASE: "ws://127.0.0.1:8080/v1",
};
```
