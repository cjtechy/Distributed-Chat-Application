#!/bin/sh
# Application-tier EC2 — FastAPI + Erlang. Run on that host:
#   sh application.sh
set -eu

APP_DIR="${APP_DIR:-/opt/chat}"
BRANCH="${DEPLOY_BRANCH:-main}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_INTERVAL_SEC="${HEALTH_INTERVAL_SEC:-2}"

log() { echo "[application] $*"; }

if [ ! -d "$APP_DIR/.git" ]; then
  log "ERROR: $APP_DIR is not a git checkout."
  exit 1
fi

cd "$APP_DIR"
log "Fetching origin/$BRANCH…"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

if [ ! -x "$APP_DIR/.venv/bin/pip" ]; then
  log "Creating Python virtualenv…"
  python3 -m venv "$APP_DIR/.venv"
fi

log "Installing Python dependencies…"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

log "Compiling Erlang messaging node…"
cd "$APP_DIR/erlang-messaging"
rebar3 compile

log "Waiting for Redis and Postgres…"
REDIS_HOST=$(grep '^REDIS_HOST=' "$APP_DIR/backend/.env" | cut -d= -f2- | tr -d '"')
POSTGRES_HOST=$(grep '^POSTGRES_HOST=' "$APP_DIR/backend/.env" | cut -d= -f2- | tr -d '"')
i=1
while [ "$i" -le 30 ]; do
  if bash -c "echo >/dev/tcp/${POSTGRES_HOST}/5432" 2>/dev/null && \
     bash -c "echo >/dev/tcp/${REDIS_HOST}/6379" 2>/dev/null; then
    break
  fi
  log "Database tier not ready ($i/30)…"
  sleep 2
  i=$((i + 1))
done

log "Restarting services…"
sudo systemctl restart chat-api
sudo systemctl restart chat-ws

wait_for() {
  name="$1"
  url="$2"
  i=1
  while [ "$i" -le "$HEALTH_RETRIES" ]; do
    if curl -sf "$url" >/dev/null; then
      log "$name healthy ($url)"
      return 0
    fi
    log "Waiting for $name ($i/$HEALTH_RETRIES)…"
    sleep "$HEALTH_INTERVAL_SEC"
    i=$((i + 1))
  done
  log "ERROR: $name failed health check: $url"
  sudo systemctl status "$name" --no-pager || true
  exit 1
}

wait_for "chat-api" "http://127.0.0.1:8000/v1/health"
wait_for "chat-ws" "http://127.0.0.1:8080/health"

log "Done ($(git -C "$APP_DIR" rev-parse --short HEAD))."
