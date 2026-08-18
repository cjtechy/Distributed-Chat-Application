# Distributed Chat Application

Real-time chat for a community: **FastAPI** for HTTP, auth, and Postgres; **Erlang/OTP** for WebSockets; **Redis** as the bus between them.

Members get a console (dashboard, group rooms, direct messages, settings). Admins get a portal for members, messages, and health. Live typing, presence, and WhatsApp-style ticks go through Erlang.

## Architecture

```
Browser  --HTTP (auth, history, groups, inbox)-->  FastAPI  -->  PostgreSQL
                                                              ^
Browser  --WS  /v1/ws?group=  (auth frame)  ---->  Erlang/OTP
                                                              |
                                                         Redis Pub/Sub
                                                         chat:inbound   Erlang → FastAPI (persist + receipts)
                                                         chat:messages  FastAPI → all Erlang nodes (deliver)
                                                         chat:group:{id}:members   membership for WS rooms
                                                         chat:online_users:{id}    presence per room
```

1. Sign-in, history, groups, DMs, and unread counts stay on FastAPI + Postgres.
2. Live sockets go to Erlang (`ws://127.0.0.1:8080/v1/ws`).
3. Erlang checks a one-time WS ticket or JWT (first frame, not the URL) and Redis membership, then publishes chat text to `chat:inbound`.
4. FastAPI batch-writes to Postgres and republishes the saved row on `chat:messages`.
5. Every Erlang node subscribed to `chat:messages` fans out to clients in that room.

Redis payloads on `chat:inbound` and `chat:messages` are HMAC-signed with `SECRET_KEY`. Unsigned or bad signatures are dropped.

Python and Erlang do not share memory. Redis is the contract. Typing and presence skip Postgres; receipts (`delivered` / `viewed`) go inbound so FastAPI can update the row.

## Project structure

```
Distributed-Chat-Application/
├── backend/
│   ├── app/
│   │   ├── main.py            HTTP pages + /v1 API
│   │   ├── database.py        Postgres (users, groups, DMs, messages, receipts)
│   │   ├── redis.py           Pub/Sub, presence, membership cache
│   │   ├── message_writer.py  Batched chat inserts
│   │   ├── auth.py            JWT + passwords
│   │   ├── security.py        HMAC bus, cookies, rate limits
│   │   └── models.py          Request/response shapes
│   ├── locustfile.py          REST + WebSocket load tests
│   ├── seed_load_users.py     Pre-register users for WS load tests
│   └── .env.example
├── erlang-messaging/          Cowboy WebSocket node
├── frontend/
│   ├── index.html             Landing
│   ├── auth/                  Sign in / register
│   ├── console/               Dashboard, chat, groups, direct, settings
│   ├── admin.html             Admin portal
│   └── config.js              API_BASE + WS_BASE
└── load-tests/                Locust / k6 / hey helpers
```

`frontend/chat.html` only redirects to `/console/chat`.

## Pages

| URL | What it is |
|-----|------------|
| `/` | Landing |
| `/auth/login`, `/auth/register` | Account |
| `/console` | Dashboard |
| `/console/chat` or `/console/chat?group=<id>` | Room (group or DM) |
| `/console/group` | Create / join groups |
| `/console/direct` | Private chats |
| `/console/settings` | Session details |
| `/admin` | Admin portal (admin sign-in if needed) |
| `/chat` | Redirects to `/console/chat` |

## Setup

You need **Python 3.11+**, **PostgreSQL**, **Redis**, and **Erlang/OTP 26+**.

From the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env
```

Edit `backend/.env` so Postgres and Redis match your machine. FastAPI and Erlang both read this file.

Create the database if it does not exist (names from `.env.example`):

```sql
CREATE USER chatapp WITH PASSWORD 'yourpassword';
CREATE DATABASE chatapp OWNER chatapp;
```

Tables are created on FastAPI startup.

Windows Erlang:

```powershell
winget install Erlang.Erlang
```

Close and reopen PowerShell after install. `erlang-messaging\start.ps1` downloads rebar3 locally.

Redis on WSL/Ubuntu:

```bash
wsl
sudo apt update
sudo apt install redis-server -y
sudo service redis-server start
redis-cli ping
```

You should see `PONG`. Point `REDIS_HOST` at `127.0.0.1` if Redis is reachable from Windows that way.

## Run

You need **both** processes.

**Terminal 1 — FastAPI**

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — Erlang**

```powershell
.\erlang-messaging\start.ps1
```

- App: [http://127.0.0.1:8000](http://127.0.0.1:8000)
- Console (after sign-in): [http://127.0.0.1:8000/console](http://127.0.0.1:8000/console)
- Erlang health: [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

`frontend/config.js`:

```javascript
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  WS_BASE: "ws://127.0.0.1:8080/v1",
};
```

The first account to register becomes admin, unless `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` create or promote an admin on startup.

Restart Erlang after changing messaging code (`start.ps1`). FastAPI `--reload` only watches `backend/`.

See [erlang-messaging/README.md](erlang-messaging/README.md).

## HTTP API (`/v1`)

Auth endpoints return a JWT. Send `Authorization: Bearer <token>` on the rest.

| Endpoint | Purpose |
|----------|---------|
| `POST /register`, `POST /login` | Account (rate-limited; sets HttpOnly session cookie) |
| `POST /logout` | Clear session cookie |
| `GET /username-available` | Username check while registering |
| `GET /me` | Current user + `is_admin` |
| `GET /ws-ticket` | One-time 30s ticket for the Erlang WebSocket |
| `GET /groups`, `POST /groups` | List / create rooms (DMs excluded from the list) |
| `GET /groups/{id}`, `POST /groups/{id}/join` | Room details / join |
| `POST /groups/{id}/read` | Mark a room read (clears unread badge) |
| `GET /people` | Other members |
| `GET /direct`, `POST /direct` | List DMs / open a DM (`{"username": "..."}`) |
| `GET /inbox` | Unread totals for Groups vs Direct |
| `GET /messages?group_id=` | History for a room |
| `GET/PATCH/DELETE /messages/{id}` | Read / edit / delete your message (must be a member of that room) |
| `GET /online?group_id=` | Who is online in that room (members only) |
| `GET /health` | Public liveness (`{"ok": true}`) |
| `GET /status` | Postgres, Redis, writer queue (authenticated) |
| `GET /admin/*` | Overview, members, messages (admin JWT) |

## WebSocket (Erlang)

`ws://127.0.0.1:8080/v1/ws?group=<id>`

First frame after connect (token is **not** put in the URL):

```json
{"type":"auth","ticket":"<from GET /v1/ws-ticket>","token":"<jwt fallback>"}
```

- Invalid auth → JSON `{"type":"error",...}` and the socket closes. Not a member of that group → same.
- `Authorization: Bearer` on the handshake still works for non-browser clients.
- Room is full → JSON `{"type":"group_full","max_users":...}` and the socket closes.
- Client → server: `{"message":"..."}` (max 4000 characters), `{"type":"typing"}`, `{"type":"delivered","ids":[...]}`, `{"type":"viewed","ids":[...]}`.
- Server → client: chat rows, `online` / `offline` / `online_list`, `typing`, `update`, `delete`, `delivered`, `viewed`.

Ticks: one grey = sent, two grey = delivered, two blue = viewed.

## Configuration (`backend/.env`)

| Variable | Purpose |
|----------|---------|
| `HOST` / `PORT` | FastAPI bind (default `127.0.0.1:8000`) |
| `SECRET_KEY` | JWT + Redis HMAC secret (min 32 bytes; never the example value) |
| `JWT_EXPIRE_HOURS` | Token lifetime (default `24`) |
| `COOKIE_SECURE` | Set `1` so the session cookie is HTTPS-only |
| `CORS_ORIGINS` | Browser origins (`*` locally; list exact origins in production) |
| `POSTGRES_*` | Database + pool (`POSTGRES_POOL_MIN` / `MAX`) |
| `MESSAGE_BATCH_SIZE` / `MESSAGE_FLUSH_MS` | Chat insert batching (default `25` / `50`) |
| `REDIS_HOST` / `PORT` / `PASSWORD` / `DB` | Redis |
| `REDIS_CHAT_CHANNEL` | Fan-out channel (default `chat:messages`) |
| `REDIS_INBOUND_CHANNEL` | Persist + receipts (default `chat:inbound`) |
| `REDIS_ONLINE_KEY` | Presence hash prefix (`chat:online_users:{group_id}`) |
| `REDIS_USERNAME_KEY` | Username cache |
| `MAX_GROUP_USERS` | Max concurrent sockets per room (default `1000`) |
| `BCRYPT_ROUNDS` | Password cost (default `12`; `4` only for load-test seeding) |
| `ERLANG_WS_PORT` | Cowboy port (default `8080`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Optional bootstrap admin |

Frontend URLs live in `frontend/config.js`. Production example: `frontend/config.example.js`.

## Deploy

### Frontend (GitHub Pages)

1. Enable **Settings → Pages → GitHub Actions**.
2. Repository variables: `API_BASE` (e.g. `https://api.yourdomain.com/v1`) and `WS_BASE` (e.g. `wss://ws.yourdomain.com/v1`).
3. Push `main` (workflow `.github/workflows/deploy-frontend.yml`).

### Backend

1. Deploy `backend/` with production Postgres, Redis, `SECRET_KEY`, and `CORS_ORIGINS`.
2. Run FastAPI behind HTTPS. Run `erlang-messaging` and terminate WSS on `ERLANG_WS_PORT`.
3. Point Pages `API_BASE` / `WS_BASE` at those hosts.

Locally, FastAPI still serves the UI at `/` and `/console`.

**Multiple FastAPI processes:** Redis Pub/Sub delivers `chat:inbound` to every subscriber. Only **one** FastAPI process should run the inbound writer, or you will duplicate rows. Extra FastAPI instances can serve HTTP only.

## Performance testing

Start FastAPI **without** `--reload` and keep Erlang running.

```powershell
pip install -r backend\requirements-dev.txt
```

| Tool | Script |
|------|--------|
| Locust (REST + WS) | `cd backend` then `locust -f locustfile.py --host=http://127.0.0.1:8000` → [http://localhost:8089](http://localhost:8089) |
| Adaptive ramp | `.\load-tests\adaptive-load.ps1` (local default: 5 users/sec, max 200) |
| WebSocket cap test | `.\load-tests\ws-load.ps1` (pre-seeds JWTs; default 1000 connections) |
| k6 | `k6 run load-tests\ws-load.js` |
| HTTP smoke | `.\load-tests\http-smoke.ps1` |

Adaptive health **ignores** `/v1/register` and `/v1/login` so bcrypt does not dominate p95.

`ws-load.ps1` optional: `BCRYPT_ROUNDS=4` in `.env` (dev only) before seeding, then restart uvicorn. Reuse tokens with `-SkipSeed`.

Cloud-scale Locust profiles (`Staging` / `Production`) are documented in [load-tests/scale-targets.md](load-tests/scale-targets.md). They are not something this laptop stack can run.

While tests run: [http://127.0.0.1:8000/v1/health](http://127.0.0.1:8000/v1/health) and [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health).

Typical local bottlenecks: bcrypt on register/login, Postgres write rate (watch `message_writer_queue`), and Windows socket limits at high WebSocket counts — not Redis pub/sub latency.

### Local benchmark (Aug 2026)

Windows laptop, FastAPI + Erlang + Redis (WSL). Architecture check, not an SLA.

**Mixed REST + WS** (`adaptive-load.ps1`, `-MaxUsers 100`, `-MaxP95Ms 2000`): ~80 concurrent users, 40 WS connections, `/v1/messages` p95 ~26 ms, WS send p95 ~1 ms, 0% failures.

**WS-only** (`ws-load.ps1`, 1000 target, 100/sec spawn): **850** stable connections, 0% connect failures, ~121 msg/s, successful send p95 ~7 ms. Send failures climbed under sustained load (`ConnectionResetError 10054`) — sockets dropped, not slow Redis.

Group cap is `MAX_GROUP_USERS` (default 1000), enforced in Erlang.
