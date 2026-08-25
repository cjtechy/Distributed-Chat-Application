#!/bin/sh
# Groups + DM load test. Uses locustfile_rooms.py (not everyone in Community).
#
# Seed first:
#   /opt/chat/.venv/bin/python /opt/chat/test/seed_load_users.py \
#     --host http://127.0.0.1:8000 --count 400 --tokens-out /tmp/load-tokens.json
#
# Usage:
#   sh /opt/chat/test/rooms-load.sh
#   LOAD_ROOM_MODE=groups LOAD_GROUP_COUNT=20 USERS=400 sh /opt/chat/test/rooms-load.sh
#   LOAD_ROOM_MODE=direct USERS=200 sh /opt/chat/test/rooms-load.sh

set -eu

ROOT="${ROOT:-/opt/chat}"
HOST="${HOST:-http://127.0.0.1:8000}"
WS_HOST="${WS_HOST:-ws://127.0.0.1:8080}"
TOKEN_FILE="${LOAD_TOKEN_FILE:-/tmp/load-tokens.json}"
USERS="${USERS:-400}"
SPAWN="${SPAWN:-10}"
TIME="${TIME:-120s}"
MODE="${LOAD_ROOM_MODE:-mixed}"
GROUPS="${LOAD_GROUP_COUNT:-20}"
LOCUST="${ROOT}/.venv/bin/locust"

if [ ! -x "$LOCUST" ]; then
  echo "ERROR: locust not found at $LOCUST"
  exit 1
fi

export WS_HOST
export LOAD_AUTH_MODE="${LOAD_AUTH_MODE:-token}"
export LOAD_TOKEN_FILE="$TOKEN_FILE"
export LOAD_ROOM_MODE="$MODE"
export LOAD_GROUP_COUNT="$GROUPS"
export LOAD_REGISTER_TIMEOUT="${LOAD_REGISTER_TIMEOUT:-120}"

echo "Rooms load test"
echo "  mode:    $MODE  (groups | direct | mixed)"
echo "  groups:  $GROUPS  (used when mode is groups or mixed)"
echo "  users:   $USERS at $SPAWN/sec for $TIME"
echo "  tokens:  $TOKEN_FILE"
echo ""

cd "$ROOT/test"
exec "$LOCUST" -f locustfile_rooms.py --host "$HOST" --headless \
  -u "$USERS" -r "$SPAWN" -t "$TIME"
