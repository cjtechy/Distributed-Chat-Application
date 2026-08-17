# Distributed Chat Application

A learning project: a real-time chat app. This phase is a **single FastAPI server** with in-memory WebSocket broadcasting. No distributed architecture, Redis Pub/Sub, PostgreSQL persistence, or authentication yet.

## Project structure

```
Distributed-Chat-Application/
├── backend/
│   ├── app/
│   │   ├── __init__.py     Makes `app` a Python package
│   │   ├── main.py         FastAPI app, /ws chat, connection list
│   │   ├── database.py     PostgreSQL ping (not used for messages yet)
│   │   ├── redis.py        Redis ping (not used for Pub/Sub yet)
│   │   └── models.py       Chat message JSON shape
│   ├── .env
│   └── requirements.txt
└── frontend/
    └── index.html          Simple WebSocket test page
```

## What each backend file does

### `backend/app/__init__.py`

Turns the `app` folder into a package so uvicorn can load `app.main:app`.

### `backend/app/models.py`

Defines the JSON every chat message must use:

```json
{ "username": "Alice", "message": "Hello everyone" }
```

Invalid payloads are rejected instead of being broadcast.

### `backend/app/database.py`

Reads Postgres settings from `.env` and pings the database. Messages are **not** saved yet. This only proves the WSL Postgres connection still works (`GET /status`).

### `backend/app/redis.py`

Creates an async Redis client from `.env` and pings it. Redis Pub/Sub is **not** used yet. Chat still lives in this one process's memory.

### `backend/app/main.py`

This is the server.

- `GET /` serves the frontend test page.
- `GET /status` shows Postgres, Redis, and how many WebSocket clients are connected.
- `WS /ws` is the chat endpoint.

`ConnectionManager` holds a Python list of open WebSocket connections. When one client sends a valid message, the server loops over that list and sends the same JSON to everyone.

## How the WebSocket connection works

1. The browser opens `ws://localhost:8000/ws`.
2. FastAPI accepts the socket and stores it in `manager.active_connections`.
3. The server waits in a loop: `receive_json()` → validate → `broadcast()`.
4. Broadcast sends `{ "username", "message" }` to every connected client, including the sender.
5. If the browser tab closes, FastAPI raises `WebSocketDisconnect` and that socket is removed from the list.

Because the list is in memory, this only works on **one** server process. Later phases can add Postgres history and Redis Pub/Sub so multiple servers can share messages.

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

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000). Open the page in two browser tabs to test broadcasting.

- Chat UI: [http://127.0.0.1:8000](http://127.0.0.1:8000)
- Status JSON: [http://127.0.0.1:8000/status](http://127.0.0.1:8000/status)
- WebSocket: `ws://localhost:8000/ws`

## Configuration

- `HOST` / `PORT` — API bind address (default `127.0.0.1:8000`)
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`

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
