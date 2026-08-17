# Distributed Chat Application

A real-time distributed chat application with a FastAPI backend, PostgreSQL as the source of truth, and Redis Pub/Sub for communication between multiple server instances.

## Project structure

```
Distributed-Chat-Application/
├── backend/
│   ├── app/
│   │   ├── __init__.py     Makes `app` a Python package
│   │   ├── main.py         FastAPI app, WebSocket chat, delivery
│   │   ├── database.py     PostgreSQL storage for messages
│   │   ├── redis.py        Redis Pub/Sub between servers
│   │   └── models.py       Chat message JSON shape
│   ├── locustfile.py       REST + WebSocket load tests (Locust)
│   ├── requirements.txt
│   └── requirements-dev.txt
├── load-tests/
│   ├── adaptive-load.ps1   Auto-ramp load test (up to 100k users)
│   ├── ws-load.js          WebSocket ramp-up test (k6)
│   └── http-smoke.ps1      Quick HTTP benchmark (hey)
└── frontend/
    ├── index.html          Landing page
    └── chat.html           Chat application
```

## Message flow

```
Frontend                Server A                 PostgreSQL          Redis              Server B
   |                       |                        |                 |                   |
   |-- WebSocket send ---->|                        |                 |                   |
   |                       |-- save message ------->|                 |                   |
   |                       |<-- saved row ----------|                 |                   |
   |                       |-- publish message --------------------->|                   |
   |                       |<-- subscriber receives -----------------|                   |
   |<-- deliver via WS ----|                        |                 |-- subscriber --->|
   |                       |                        |                 |                   |-- deliver via WS --> clients
```

1. The frontend sends JSON over `ws://localhost:8000/v1/ws`.
2. FastAPI validates the message and saves it to PostgreSQL.
3. FastAPI publishes the saved message to the Redis channel `chat:messages`.
4. Every FastAPI server subscribed to that channel receives the message.
5. Each server delivers the message to its own connected WebSocket clients.

PostgreSQL is the source of truth. Redis is the communication layer between servers.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Landing page |
| `GET /chat` | Chat application |
| `POST /v1/register` | Create a new user account |
| `POST /v1/login` | Log in and receive a JWT token |
| `GET /v1/me` | Return the logged-in username |
| `GET /v1/messages` | Recent saved messages (requires login) |
| `GET /v1/messages/{id}` | Read one message |
| `PATCH /v1/messages/{id}` | Edit your own message |
| `DELETE /v1/messages/{id}` | Delete your own message |
| `GET /v1/online` | List online users |
| `GET /v1/status` | Postgres, Redis, and connected WebSocket count |
| `WS /v1/ws?token=...` | Send and receive live chat messages (requires login) |

## Setup

From the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
Copy-Item backend\.env.example backend\.env
```

Edit `backend/.env` to match your WSL Postgres and Redis settings.

## Run

From the `backend` folder:

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for the landing page, or [http://127.0.0.1:8000/chat](http://127.0.0.1:8000/chat) to chat directly. Open the chat in two tabs to test live messaging.

To test multiple servers, start a second instance on another port:

```powershell
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Both servers share the same Redis channel and PostgreSQL database.

## Performance testing

Load-test the API as concurrent users increase. Start the server **without** `--reload` for realistic numbers:

```powershell
cd backend
..\.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Optional: run a second instance on port `8001` to test Redis cross-server delivery under load.

### Install load test tools

```powershell
pip install -r backend\requirements-dev.txt
```

- **[Locust](https://locust.io/)** — REST + WebSocket ramp-up (included in `requirements-dev.txt`)
- **[k6](https://k6.io/docs/get-started/installation/)** — WebSocket stages script in `load-tests/ws-load.js`
- **[hey](https://github.com/rakyll/hey)** (optional) — quick HTTP smoke test via `load-tests/http-smoke.ps1`

### Locust (REST + WebSocket)

From the `backend` folder:

```powershell
cd backend
locust -f locustfile.py --host=http://127.0.0.1:8000
```

Open [http://localhost:8089](http://localhost:8089). Ramp users in steps (e.g. **10 → 50 → 100 → 250**) and watch RPS, p95 latency, and failures.

Locust runs two user types:

| User class | Simulates |
|------------|-----------|
| `ChatHttpUser` | Register, `GET /v1/messages`, `/v1/status`, `/v1/online` |
| `ChatWebSocketUser` | WebSocket connect, send messages, typing events |

### Adaptive load test (auto-ramp to 100k users)

Ramps **up to 100,000 concurrent users** at **100 users/sec** while the API stays healthy. Stops increasing when p95 latency or error rate gets too high, waits, then tries again.

```powershell
.\load-tests\adaptive-load.ps1
```

Customize:

```powershell
.\load-tests\adaptive-load.ps1 -SpawnRate 200 -MaxUsers 100000 -MaxP95Ms 300
```

Or run directly:

```powershell
cd backend
$env:LOAD_SPAWN_RATE = "100"
$env:LOAD_MAX_USERS = "100000"
$env:LOAD_MAX_P95_MS = "500"
locust -f locustfile.py --host=http://127.0.0.1:8000 --headless
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOAD_START_USERS` | `10` | Initial concurrent users |
| `LOAD_MAX_USERS` | `100000` | Ceiling — stop ramping here |
| `LOAD_SPAWN_RATE` | `100` | Users added per second while healthy |
| `LOAD_MAX_P95_MS` | `500` | Pause ramp if p95 latency exceeds this |
| `LOAD_MAX_FAIL_RATIO` | `0.02` | Pause ramp if failures exceed 2% |
| `LOAD_RECOVERY_TICKS` | `15` | Seconds to hold before retrying ramp |
| `LOAD_MAX_RUNTIME_SEC` | `3600` | Stop test after 1 hour |

Watch the terminal for `[adaptive]` lines showing target users, p95, and failure rate.

For a **manual fixed ramp**, use the Locust UI (http://localhost:8089) and set users/spawn rate yourself — comment out `AdaptiveLoadShape` in `locustfile.py` first, or Locust will override your settings.

### k6 (WebSocket ramp-up)

```powershell
k6 run load-tests/ws-load.js
k6 run -e BASE_URL=http://127.0.0.1:8000 load-tests/ws-load.js
```

The script registers a user, opens a WebSocket, sends messages, and ramps **10 → 50 → 100** concurrent virtual users.

### Quick HTTP smoke (hey)

```powershell
.\load-tests\http-smoke.ps1
.\load-tests\http-smoke.ps1 -Concurrency 100 -Requests 5000
```

### What to watch

While tests run, check [http://127.0.0.1:8000/v1/status](http://127.0.0.1:8000/v1/status) for `websocket_clients`, Postgres, and Redis health.

| Metric | Target (adjust for your hardware) |
|--------|-----------------------------------|
| `GET /v1/status` p95 | < 100 ms |
| `GET /v1/messages` p95 @ 100 users | < 200 ms |
| WebSocket connect failures | < 1% |
| Error rate overall | < 1% |

Expected bottlenecks: **bcrypt on login/register**, **Postgres writes per chat message**, and **RAM/file descriptors** at high WebSocket counts.

## Scalability architecture

The message path is designed as an **asynchronous, non-blocking pipeline**:

```
Client → WebSocket → FastAPI instance
                         │
                         ├──► PostgreSQL (persist — source of truth)
                         └──► Redis Pub/Sub (broadcast to all instances)
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                    FastAPI #1            FastAPI #2
                         │                     │
                         ▼                     ▼
                    WebSocket clients     WebSocket clients
```

**Roles:**

| Component | Role |
|-----------|------|
| **PostgreSQL** | Permanent message storage |
| **Redis Pub/Sub** | Real-time coordination between server instances |
| **FastAPI WebSockets** | Live client connections |
| **Load balancer** | Distributes HTTP/WebSocket traffic across instances (production) |

**Implementation details:**

- **Async Redis client** — publish/subscribe without blocking the event loop
- **Async PostgreSQL pool** (`psycopg-pool`) — reusable connections instead of opening one per request
- **Index on `messages(id DESC)`** — faster history queries
- **WebSocket handler** — `await save_message()` then `await publish_message()` on the async pool (no thread pool)

The WebSocket handler still waits for Postgres before publishing so Redis always carries persisted message IDs. That keeps PostgreSQL as the source of truth. For higher throughput you could decouple with a background queue, at the cost of stronger consistency guarantees.

**Horizontal scaling:** run multiple uvicorn instances (ports 8000, 8001, …) behind nginx. All instances share the same Postgres database and Redis channel.

**Further optimizations (production):**

- Connection pooling tuning (`POSTGRES_POOL_MIN`, `POSTGRES_POOL_MAX`)
- Read replicas for read-heavy endpoints
- Managed Postgres/Redis with autoscaling
- Sticky sessions or WebSocket-aware load balancing

### Load test findings (local)

| Users | REST failures | WS send failures | Notes |
|-------|---------------|------------------|-------|
| ~15 | 0% | 0% | Sweet spot |
| ~25 | 0% | ~20% | WS degrades |
| ~50 | 0% | ~47% | HTTP still healthy |

REST API sustained **50 concurrent users with 0% errors** (p95 under 420 ms). WebSocket limits on local Windows + Locust are lower than real browser clients.

## Configuration

- `HOST` / `PORT` — API bind address (default `127.0.0.1:8000`)
- `SECRET_KEY` — JWT signing secret
- `JWT_EXPIRE_HOURS` — token lifetime in hours (default `24`)
- `CORS_ORIGINS` — comma-separated frontend URLs allowed to call the API (use `*` locally)
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `POSTGRES_POOL_MIN`, `POSTGRES_POOL_MAX` — async connection pool size (default `2` / `20`)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_CHAT_CHANNEL`

Frontend API URL is configured in `frontend/config.js` (see `frontend/config.example.js` for production).

## Deploy separately

### Frontend (GitHub Pages)

1. Push the repo to GitHub.
2. Enable **Settings → Pages → Build and deployment → GitHub Actions**.
3. Add a repository variable **Settings → Secrets and variables → Actions → Variables**:
   - Name: `API_BASE`
   - Value: `https://api.yourdomain.com/v1`
4. Push to `main` (or run the **Deploy Frontend to GitHub Pages** workflow manually).

The workflow in `.github/workflows/deploy-frontend.yml` deploys the `frontend/` folder and writes `config.js` with your `API_BASE`.

### Backend (API server)

1. Deploy the `backend/` folder to your host (VPS, Railway, Render, Fly.io, etc.).
2. Set `.env` with production Postgres, Redis, `SECRET_KEY`, and `CORS_ORIGINS`:
   ```
   CORS_ORIGINS=https://yourname.github.io,https://chat.yourdomain.com
   ```
3. Run behind HTTPS with a reverse proxy (nginx, Caddy):
   ```bash
   uvicorn app.main:app --host 0.0.0.0 --port 8000
   ```
4. Point `api.yourdomain.com` at the server. WebSockets use `wss://api.yourdomain.com/v1/ws`.

Locally, the backend still serves the frontend at `/` and `/chat`. In production you can rely on GitHub Pages for the UI and use the backend as API-only.

## Redis (WSL / Ubuntu)

### 1. Open Ubuntu (WSL)

```bash
wsl
```

Check your distro:

```bash
cat /etc/os-release
```

### 2. Update packages

```bash
sudo apt update
```

### 3. Install Redis

```bash
sudo apt install redis-server -y
```

### 4. Start Redis

```bash
sudo service redis-server start
```

Check its status:

```bash
sudo service redis-server status
```

You should see that Redis is running.

### 5. Test Redis

```bash
redis-cli ping
```

You should get:

```
PONG
```
