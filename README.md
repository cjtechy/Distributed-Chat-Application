# Distributed Chat Application

Real-time chat for a community: a **static frontend**, **FastAPI** for HTTP, auth, and Postgres; **Erlang/OTP** for WebSockets; **Redis** as the bus between them.

Members get a console (chats, group rooms, direct messages, settings). Admins get a portal for members, messages, and health. Live typing, presence, and WhatsApp-style ticks go through Erlang. Voice notes are transcribed on the server. Audio and video calls use WebRTC, with a phone-style overlay that rings on every console screen.

## Architecture

```
Browser  --static HTML/CSS/JS-->  GitHub Pages (or python -m http.server)

Browser  --HTTP (auth, history, groups, inbox, calls, voice)-->  FastAPI  -->  PostgreSQL
                                                                              ^
Browser  --WS  /v1/ws?group=  (auth frame)  ---------------->  Erlang/OTP
                                                                              |
                                                                         Redis Pub/Sub
                                                                         chat:inbound   Erlang → FastAPI (persist + receipts)
                                                                         chat:messages  FastAPI → all Erlang nodes (deliver)
                                                                         chat:group:{id}:members   membership for WS rooms
                                                                         chat:online_users:{id}    presence per room
                                                                         chat:call:ring:{user}     incoming-call inbox
```

1. The UI is static files in `frontend/`. FastAPI does **not** serve those pages (`/` on the API returns `{"message":"api server running"}`).
2. Sign-in, history, groups, DMs, unread counts, transcription, and call signaling stay on FastAPI + Postgres.
3. Live sockets go to Erlang (`ws://127.0.0.1:8080/v1/ws`).
4. Erlang checks a one-time WS ticket or JWT (first frame, not the URL) and Redis membership, then publishes chat text to `chat:inbound`.
5. FastAPI batch-writes to Postgres and republishes the saved row on `chat:messages`.
6. Every Erlang node subscribed to `chat:messages` fans out to clients in that room.

Redis payloads on `chat:inbound` and `chat:messages` are HMAC-signed with `SECRET_KEY`. Unsigned or bad signatures are dropped.

Python and Erlang do not share memory. Redis is the contract. Typing and presence skip Postgres; receipts (`delivered` / `viewed`) go inbound so FastAPI can update the row.

### Voice notes

The browser records a short WAV clip and `POST`s it to `/v1/transcribe`. FastAPI runs [SpeechRecognition](https://pypi.org/project/SpeechRecognition/) (`recognize_google`) and returns text into the compose box. No Whisper, no in-browser Web Speech API.

### Calls

Media is **peer-to-peer WebRTC** by default (STUN; optional TURN). Set `WEBRTC_MODE=sfu` and install `aiortc` to relay media through Python.

Signaling is HTTP, not a second WebSocket:

1. `POST /v1/webrtc/signal` publishes `call_*` events on Redis `chat:messages`.
2. Erlang fans those events to whoever is connected to **that room**.
3. Invites are also written to `chat:call:ring:{username}` so a callee who is elsewhere in the app still rings.

Every console page loads `call.js`, polls `GET /v1/webrtc/inbox`, and shows a full-screen overlay (Accept / Decline) above chats, groups, settings, and other rooms. Accepting from another screen opens the right chat and joins. Call events are not stored as chat messages.

If both people call each other at once, one invite is kept and the other side auto-joins (glare). They connect instead of both rings dropping.

## Project structure

```
Distributed-Chat-Application/
├── backend/
│   ├── app/
│   │   ├── main.py            /v1 HTTP API (no static UI)
│   │   ├── database.py        Postgres (users, groups, DMs, messages, receipts)
│   │   ├── redis.py           Pub/Sub, presence, membership cache, call inbox
│   │   ├── message_writer.py  Batched chat inserts
│   │   ├── transcribe.py      SpeechRecognition voice-to-text
│   │   ├── webrtc.py          ICE servers + call signal types
│   │   ├── sfu.py             Optional aiortc media relay
│   │   ├── auth.py            JWT + passwords
│   │   ├── security.py        HMAC bus, cookies, rate limits
│   │   └── models.py          Request/response shapes
│   ├── locustfile.py          REST + WebSocket load tests
│   ├── seed_load_users.py     Pre-register users for WS load tests
│   └── .env.example
├── erlang-messaging/          Cowboy WebSocket node (chat + call fan-out)
├── frontend/
│   ├── index.html             Landing
│   ├── auth/                  Sign in / register
│   ├── console/               Chats, rooms, groups, direct, settings
│   ├── scripts/call.js        Global incoming-call overlay
│   ├── admin.html             Admin portal
│   └── config.js              API_BASE + WS_BASE
├── deploy/                    EC2 userdata + backend deploy script
└── load-tests/                Locust / k6 / hey helpers
```

`frontend/chat.html` only redirects to `/console/chat`.

## Pages

These URLs are the **static frontend**, not FastAPI.

| URL | What it is |
|-----|------------|
| `/` | Landing |
| `/auth/login`, `/auth/register` | Account |
| `/console` | Chat list |
| `/console/chat` or `/console/chat?group=<id>` | Room (group or DM); calls start here |
| `/console/group` | Create / join groups |
| `/console/direct` | Private chats |
| `/console/settings` | Session details |
| `/admin` | Admin portal (admin sign-in if needed) |
| `/chat` | Redirects to `/console/chat` |

Incoming calls overlay every `/console/*` screen. Camera and microphone need a secure context (HTTPS, or `http://127.0.0.1`).

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

You need **three** processes: API, Erlang, and the static UI.

**Terminal 1 — FastAPI**

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — Erlang**

```powershell
.\erlang-messaging\start.ps1
```

**Terminal 3 — frontend**

```powershell
cd frontend
python -m http.server 5500
```

- App: [http://127.0.0.1:5500](http://127.0.0.1:5500)
- Console (after sign-in): [http://127.0.0.1:5500/console](http://127.0.0.1:5500/console)
- API health: [http://127.0.0.1:8000/v1/health](http://127.0.0.1:8000/v1/health)
- Erlang health: [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

`frontend/config.js` (local defaults):

```javascript
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  WS_BASE: "ws://127.0.0.1:8080/v1",
};
```

The first account to register becomes admin, unless `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` create or promote an admin on startup.

Restart Erlang after changing messaging code (`start.ps1`). FastAPI `--reload` only watches `backend/`. Hard-refresh the frontend after changing JS/CSS.

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
| `POST /transcribe` | Voice note → text (`multipart` WAV, SpeechRecognition) |
| `GET /webrtc/ice` | STUN/TURN servers + `p2p` / `sfu` mode |
| `POST /webrtc/signal` | Call signaling (`call_invite`, accept, reject, hangup, SDP, ICE) |
| `GET /webrtc/inbox` | Pending incoming call for this user (global ring) |
| `POST /webrtc/sfu/{call_id}` | SFU offer/answer/leave (only if `WEBRTC_MODE=sfu`) |
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
- Server → client: chat rows, `online` / `offline` / `online_list`, `typing`, `update`, `delete`, `delivered`, `viewed`, and `call_*` signaling (invite / accept / reject / hangup / offer / answer / ice) for clients **in that room**. Callees who are elsewhere in the app get the invite from `GET /webrtc/inbox`.

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
| `TRANSCRIBE_LANGUAGE` | SpeechRecognition language (default `en-US`) |
| `TRANSCRIBE_MAX_BYTES` | Max voice upload (default `5242880`) |
| `WEBRTC_MODE` | `p2p` (default) or `sfu` (needs `aiortc`) |
| `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD` | Optional TURN for calls behind strict NAT |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Optional bootstrap admin |

Frontend URLs live in `frontend/config.js`. Pages deploys overwrite that file from repo variables `API_BASE` and `WS_BASE`.

## Deploy

### Frontend (GitHub Pages)

1. Enable **Settings → Pages → GitHub Actions**.
2. Repository variables: `API_BASE` (e.g. `https://api.yourdomain.com/v1`) and `WS_BASE` (e.g. `wss://ws.yourdomain.com/v1`).
3. Push `main` (workflow `.github/workflows/deploy-frontend.yml`).

### Backend (EC2 + GitHub Actions)

The backend is **not** deployed by Pages. Use two EC2 instances (database + logic) or adapt the scripts for your cloud.

**One-time bootstrap**

1. Launch a **database** instance (Ubuntu 24.04). Paste `deploy/ec2-db-userdata.sh` into user data. Note its **private IP**.
2. Launch a **logic** instance in the same VPC. Edit `deploy/ec2-logic-userdata.sh`:
   - `DB_PRIVATE_IP`, `API_DOMAIN`, `WS_DOMAIN`, `FRONTEND_ORIGIN` (your Pages URL), `SECRET_KEY`, passwords.
3. Paste the edited script into user data and launch. It installs Postgres/Redis clients, FastAPI, Erlang, nginx, and Let's Encrypt.
4. Security groups: logic instance — inbound 22, 80, 443; database — 5432 and 6379 from logic SG only.

**Automated deploys (GitHub Actions)**

Workflow: `.github/workflows/deploy-backend.yml` — runs on push to `main` when `backend/` or `erlang-messaging/` changes (or manually via **Actions → Deploy Backend to EC2**).

Repository **secrets** (Settings → Secrets and variables → Actions):

| Secret | Example |
|--------|---------|
| `EC2_HOST` | Public IP or `api.yourdomain.com` |
| `EC2_SSH_KEY` | Private key (`.pem`) for the logic instance |
| `EC2_USER` | `ubuntu` |
| `EC2_PORT` | `22` (optional) |

Optional **variable**: `APP_DIR` = `/opt/chat` (default).

Optional GitHub **environment** named `production` (workflow uses it for approval gates if you enable them).

Each deploy runs `deploy/deploy-backend.sh` on the server: `git pull`, `pip install`, `rebar3 compile`, restart `chat-api` + `chat-ws`, health checks.

**Frontend ↔ backend wiring**

Set repository variables for Pages (same as above):

- `API_BASE` → `https://api.yourdomain.com/v1`
- `WS_BASE` → `wss://ws.yourdomain.com/v1`

Ensure `CORS_ORIGINS` on the server includes your Pages origin (set in `backend/.env` by userdata). Calls need HTTPS on the Pages origin so the browser allows camera and microphone.

**Manual deploy** (SSH into logic instance):

```bash
bash /opt/chat/deploy/deploy-backend.sh
```

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
