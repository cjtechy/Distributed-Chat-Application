# Distributed Chat Application

A real-time distributed chat application: FastAPI for HTTP/auth/Postgres, Redis as the service bus, and an optional Erlang/OTP node for WebSocket connections.

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
├── erlang-messaging/           Optional OTP WebSocket node (Cowboy + Redis)
├── load-tests/
│   ├── adaptive-load.ps1   Auto-ramp load test (up to 100k users)
│   ├── ws-load.js          WebSocket ramp-up test (k6)
│   └── http-smoke.ps1      Quick HTTP benchmark (hey)
└── frontend/
    ├── index.html          Landing page
    └── chat.html           Chat application
```

## Message flow

Python-only (default, FastAPI owns WebSockets):

```
Frontend --WS--> FastAPI --save--> PostgreSQL
                    |
                    +--publish--> Redis chat:messages --> other FastAPI nodes
```

With the Erlang messaging node:

```
Frontend --HTTP (auth, history, CRUD)--> FastAPI --> PostgreSQL
                                              ^
Frontend --WS---------------------------> Erlang/OTP
                                              |
                                         Redis Pub/Sub
                                         chat:inbound  (Erlang -> FastAPI, persist)
                                         chat:messages (FastAPI -> all nodes, deliver)
```

1. Login/register and message history stay on FastAPI.
2. Live connections go to Erlang (`ws://127.0.0.1:8080/v1/ws`) when `WS_BASE` is set.
3. Erlang verifies the JWT, then publishes chat text to `chat:inbound`.
4. FastAPI batch-writes to Postgres and republishes the saved row on `chat:messages`.
5. Every Erlang (and FastAPI) node subscribed to `chat:messages` delivers to its local clients.

Python and Erlang do not share memory or call each other in-process. Redis is the contract.

If `WS_BASE` is omitted, the browser keeps using FastAPI's `/v1/ws` endpoint.

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
| `WS /v1/ws?token=...` | FastAPI WebSocket (used when Erlang is not running) |
| Erlang `WS /v1/ws?token=...` | OTP messaging node on port 8080 |
| Erlang `GET /health` | Messaging node health + local connection count |

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

### Optional: Erlang/OTP messaging

FastAPI can keep serving HTTP while Erlang owns WebSockets (better connection concurrency).

```powershell
.\erlang-messaging\start.ps1
```

Health: [http://127.0.0.1:8080/health](http://127.0.0.1:8080/health)

Point the frontend at the node in `frontend/config.js`:

```javascript
window.APP_CONFIG = {
  API_BASE: "http://127.0.0.1:8000/v1",
  WS_BASE: "ws://127.0.0.1:8080/v1",
};
```

See [erlang-messaging/README.md](erlang-messaging/README.md).

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

### Adaptive load test

Ramps concurrent users while the API stays healthy. Stops when p95 latency or errors exceed thresholds.

**Local (laptop):**

```powershell
.\load-tests\adaptive-load.ps1
.\load-tests\adaptive-load.ps1 -Profile Local
```

Defaults: **5 users/sec**, max **200** concurrent users.

**Production design target (100,000 users/sec):**

This is **not runnable on localhost**. It requires cloud deployment + distributed Locust workers.

```powershell
.\load-tests\adaptive-load.ps1 -Profile Production -HostUrl https://api.example.com
```

See [load-tests/scale-targets.md](load-tests/scale-targets.md) for the full scaling roadmap.

| Profile | Spawn rate | Max users | Where to run |
|---------|------------|-----------|--------------|
| `Local` | 5/sec | 200 | Your laptop |
| `Staging` | 500/sec | 10,000 | Cloud staging cluster |
| `Production` | **100,000/sec** | 100,000 | Distributed Locust on cloud VMs |

Customize:

```powershell
.\load-tests\adaptive-load.ps1 -SpawnRate 10 -MaxUsers 500 -MaxP95Ms 300
```

Or run directly:

```powershell
cd backend
$env:LOAD_SPAWN_RATE = "5"
$env:LOAD_MAX_USERS = "200"
locust -f locustfile.py --host=http://127.0.0.1:8000 --headless
```

| Variable | Local default | Production target |
|----------|---------------|-------------------|
| `LOAD_START_USERS` | `10` | `1000` |
| `LOAD_MAX_USERS` | `200` | `100000` |
| `LOAD_SPAWN_RATE` | `5` | `100000` |
| `LOAD_MAX_P95_MS` | `500` | `200` |
| `LOAD_MAX_FAIL_RATIO` | `0.02` | `0.01` |
| `LOAD_RECOVERY_TICKS` | `15` | `15` |
| `LOAD_MAX_RUNTIME_SEC` | `3600` | `3600` |

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

Expected bottlenecks: **bcrypt on login/register**, **Postgres writes per chat message** (mitigated by batch writer), and **RAM/file descriptors** at high WebSocket counts.

## Scalability architecture

The message path is designed as an **asynchronous, non-blocking pipeline**:

```
                    Frontend
                       │
          ┌────────────┼────────────┐
          ▼                         ▼
       FastAPI                  Erlang/OTP
       (Python)                 Messaging
      /        \                    │
     ▼          ▼                   │
 PostgreSQL    Redis ◄──────────────┘
```

**Roles:**

| Component | Role |
|-----------|------|
| **FastAPI** | HTTP API, JWT auth, Postgres writes, inbound subscriber |
| **PostgreSQL** | Permanent message storage |
| **Redis Pub/Sub** | Contract between Python and Erlang (and between nodes) |
| **Erlang/OTP** | WebSocket connections and fan-out (optional; FastAPI WS still works) |
| **Load balancer** | HTTP to FastAPI, WebSocket to Erlang in production |

**Implementation details:**

- **Async Redis client** — publish/subscribe without blocking the event loop
- **Async PostgreSQL pool** (`psycopg-pool`) — reusable connections instead of opening one per request
- **Batched message writer** — queues chat inserts and flushes up to 25 rows every 50 ms (configurable)
- **Index on `messages(id DESC)`** — faster history queries
- **Python WebSocket path** — `await message_writer.save()` then `await publish_message()`
- **Erlang path** — Cowboy WS → `chat:inbound` → FastAPI persist → `chat:messages` → OTP fan-out

Messages are buffered and written in batches to reduce Postgres round-trips. At very high load, watch `/v1/status` → `message_writer_queue` — if it keeps growing, increase batch size or add PgBouncer/read replicas (see [load-tests/scale-targets.md](load-tests/scale-targets.md)).

**Horizontal scaling:** run multiple FastAPI instances for HTTP and multiple Erlang nodes for WebSockets. All share Postgres and Redis. Do not embed Erlang in the Python process.

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

**Design target:** 100,000 users/sec on horizontally scaled cloud infrastructure (see [load-tests/scale-targets.md](load-tests/scale-targets.md)). Local tests validate architecture; reaching production scale requires distributed load generators and a Kubernetes-style deployment.

## Configuration

- `HOST` / `PORT` — API bind address (default `127.0.0.1:8000`)
- `SECRET_KEY` — JWT signing secret
- `JWT_EXPIRE_HOURS` — token lifetime in hours (default `24`)
- `CORS_ORIGINS` — comma-separated frontend URLs allowed to call the API (use `*` locally)
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `POSTGRES_POOL_MIN`, `POSTGRES_POOL_MAX` — async connection pool size (default `2` / `20`)
- `MESSAGE_BATCH_SIZE`, `MESSAGE_FLUSH_MS` — batch chat inserts before flushing to Postgres (default `25` / `50`)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_CHAT_CHANNEL`
- `REDIS_INBOUND_CHANNEL` — Erlang → FastAPI persist path (default `chat:inbound`)
- `ERLANG_WS_PORT` — OTP messaging listen port (default `8080`)

Frontend URLs are in `frontend/config.js`: `API_BASE` (FastAPI) and optional `WS_BASE` (Erlang). See `frontend/config.example.js`.

## Deploy separately

### Frontend (GitHub Pages)

1. Push the repo to GitHub.
2. Enable **Settings → Pages → Build and deployment → GitHub Actions**.
3. Add a repository variable **Settings → Secrets and variables → Actions → Variables**:
   - Name: `API_BASE`
   - Value: `https://api.yourdomain.com/v1`
   - Optional: `WS_BASE` = `wss://ws.yourdomain.com/v1` (Erlang messaging node)
4. Push to `main` (or run the **Deploy Frontend to GitHub Pages** workflow manually).

The workflow in `.github/workflows/deploy-frontend.yml` deploys the `frontend/` folder and writes `config.js` with your `API_BASE` (and `WS_BASE` if set).

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
4. Point `api.yourdomain.com` at FastAPI. For Erlang messaging, run `erlang-messaging` and point `ws.yourdomain.com` (WSS) at port 8080, then set `WS_BASE`.

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
