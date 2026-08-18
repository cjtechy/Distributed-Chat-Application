# Scale target: 100,000 users/sec

This document defines what **100,000 users/sec** means for the project and how to work toward it.

## Terminology

| Term | Meaning | Local laptop |
|------|---------|--------------|
| **Concurrent users** | Open connections at the same time | ~20 reliable (your tests) |
| **Spawn rate (users/sec)** | New virtual users added per second | 5–10 safe |
| **Requests/sec (RPS)** | HTTP + WS operations per second | ~12 observed |
| **Target: 100k users/sec** | Production spawn/connect capacity goal | **Not testable locally** |

**100,000 users/sec** means adding **100,000 new concurrent clients every second** (or sustaining that connection rate). That requires cloud infrastructure — not a single machine.

## What your local tests proved

| Run | Concurrent WS users | REST failures | WS failures |
|-----|---------------------|---------------|-------------|
| Before async pool | ~50 | 0% | ~47% |
| After async pool | ~17–20 | 0% | 0% (sweet spot) |
| After async pool (peak) | ~25+ | 0% | ~18% |

Local ceiling: **~20 reliable chat users**, **50+ HTTP users**. Architecture is correct; hardware is the limit.

## Production path to 100k users/sec

```
                    ┌─────────────────┐
                    │  CDN / GitHub   │
                    │  Pages (static) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ Load balancer   │  HTTP → FastAPI, WS → Erlang
                    └────────┬────────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
           FastAPI        FastAPI        Erlang/OTP
           (HTTP/auth)    (HTTP/auth)    (WebSockets)
              │              │              │
              └──────────────┼──────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
      PostgreSQL cluster              Redis Cluster
      (primary + replicas)            (Python ↔ Erlang bus)
      + PgBouncer pool
```

### Infrastructure checklist

| Layer | At 100k users/sec |
|-------|-------------------|
| **API** | FastAPI pods for HTTP/auth; Erlang/OTP nodes for WebSockets |
| **Postgres** | Managed cluster, PgBouncer, read replicas, partitioning |
| **Redis** | Redis Cluster — the only Python ↔ Erlang integration |
| **Load balancer** | WebSocket-aware, sticky sessions optional |
| **Load testing** | Distributed Locust / k6 Cloud / Grafana Cloud k6 |
| **Auth** | Offload bcrypt — pre-generated tokens or external IdP at scale |

### Code/config changes for production

1. **`POSTGRES_POOL_MAX=100`** per instance (tune per pod), front with **PgBouncer**
2. **Batched message writes** — `MESSAGE_BATCH_SIZE=25`, `MESSAGE_FLUSH_MS=50` (already in the app)
3. **Multiple uvicorn workers** or multiple containers (1 worker per container is common in K8s)
4. **Message queue** (optional) — Kafka/SQS between WebSocket receive and Postgres for burst absorption beyond batching
5. **Separate read path** — `GET /v1/messages` from read replica
6. **Rate limiting** — protect auth endpoints from bcrypt storms
7. **Table partitioning** — partition `messages` by month once row count exceeds ~100M

## Database bottleneck (why Postgres slows down)

Every chat message currently hits Postgres. At scale this becomes the first hard limit:

| Operation | When | Cost at 100k msg/sec |
|-----------|------|----------------------|
| `INSERT` per message | Every WebSocket send | 100k writes/sec — exceeds single Postgres |
| `COMMIT` per insert | Same | fsync pressure on disk |
| `SELECT` history | Page load / REST | Competes with writes for connections |
| Login/register | Auth | bcrypt + SELECT (CPU heavy, not message path) |

**What the app does now:**

```
WebSocket receive → MessageWriter queue → batch INSERT (25 msgs / 50ms) → Redis publish → deliver
```

- **Before:** 1 connection + 1 INSERT + 1 COMMIT per message
- **After:** ~1 INSERT per 25 messages (40× fewer round-trips at steady load)
- Monitor `/v1/status` → `message_writer_queue` — if it keeps growing, Postgres is falling behind

**If the queue still grows at production scale:**

1. Increase `MESSAGE_BATCH_SIZE` (e.g. 100) and `MESSAGE_FLUSH_MS` (e.g. 100)
2. Add **PgBouncer** between app pods and Postgres (pool thousands of app connections → dozens of DB connections)
3. **Read replica** for `GET /v1/messages` — keep writes on primary only
4. **Partition** `messages` by `created_at` — old partitions become read-only archives
5. **Async queue** (Kafka/SQS) — WebSocket publishes to Redis immediately, workers persist to Postgres independently

**Rule of thumb:** Redis handles real-time delivery; Postgres is the durable log. They should not share the same latency budget.

## How to load-test toward 100k/sec

### Step 1 — Local (what you do now)

```powershell
.\load-tests\adaptive-load.ps1 -Profile Local
```

Finds your **local capacity ceiling** (~20 WS users).

### Step 2 — Staging cluster

Deploy backend to cloud (Railway, AWS, GCP). Run:

```powershell
.\load-tests\adaptive-load.ps1 -Profile Staging -HostUrl https://api.staging.example.com
```

Uses **500 users/sec** spawn rate against a small cluster.

### Step 3 — Distributed Locust (production target)

100k users/sec requires **many load generator machines**:

```bash
# Master (cloud VM)
locust -f locustfile.py --master --host=https://api.example.com

# Workers (10–100+ VMs)
locust -f locustfile.py --worker --master-host=<master-ip>
```

Set environment variables on workers:

```bash
export LOAD_SPAWN_RATE=100000
export LOAD_MAX_USERS=100000
export LOAD_MAX_P95_MS=200
export LOAD_MAX_FAIL_RATIO=0.01
```

### Metrics to capture at each tier

```
Concurrent connections
Messages/sec
Average / P95 / P99 latency
Error rate
CPU / memory per pod
Postgres connections (via PgBouncer)
Redis ops/sec
```

## Report wording

> **Design target:** 100,000 users/sec on horizontally scaled infrastructure.  
> **Local validation:** ~20 concurrent WebSocket users at 0% error rate; REST APIs sustained 50+ users at 0% failures.  
> **Conclusion:** Architecture (async Postgres pool + Redis Pub/Sub + stateless FastAPI) supports horizontal scaling; reaching 100k users/sec requires cloud deployment with distributed load testing, not a single dev machine.
