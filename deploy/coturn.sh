#!/bin/sh
# Install Coturn on the application EC2 and point FastAPI at it.
#   sudo sh /opt/chat/deploy/coturn.sh
#
# Security group (this instance): inbound
#   UDP 3478, TCP 3478, UDP 49160-49200  from 0.0.0.0/0
set -eu

APP_DIR="${APP_DIR:-/opt/chat}"
ENV_FILE="${ENV_FILE:-$APP_DIR/backend/.env}"
TURN_USER="${TURN_USERNAME:-chatturn}"
MIN_PORT="${TURN_MIN_PORT:-49160}"
MAX_PORT="${TURN_MAX_PORT:-49200}"
REALM="${TURN_REALM:-techgroupkenya.co.ke}"

log() { echo "[coturn] $*"; }

upsert_env() {
  key="$1"
  value="$2"
  if [ ! -f "$ENV_FILE" ]; then
    log "ERROR: $ENV_FILE not found."
    exit 1
  fi
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

imds_token() {
  curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true
}

imds() {
  path="$1"
  token="$2"
  if [ -n "$token" ]; then
    curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/${path}" || true
  else
    curl -fsS "http://169.254.169.254/latest/meta-data/${path}" || true
  fi
}

TOKEN="$(imds_token)"
PUBLIC_IP="${TURN_PUBLIC_IP:-}"
PRIVATE_IP="$(imds local-ipv4 "$TOKEN")"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(imds public-ipv4 "$TOKEN")"
fi
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS https://ifconfig.me/ip || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
  log "ERROR: could not detect public IP."
  exit 1
fi

if grep -q '^TURN_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
  TURN_PASS="$(grep '^TURN_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
fi
if [ -z "${TURN_PASS:-}" ]; then
  TURN_PASS="$(openssl rand -hex 16)"
fi

log "Installing coturn…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coturn

if [ -f /etc/default/coturn ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  grep -q '^TURNSERVER_ENABLED=' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi

EXTERNAL_LINE="external-ip=${PUBLIC_IP}"
if [ -n "$PRIVATE_IP" ]; then
  EXTERNAL_LINE="external-ip=${PUBLIC_IP}/${PRIVATE_IP}"
fi

log "Writing /etc/turnserver.conf (public ${PUBLIC_IP})…"
cat > /etc/turnserver.conf <<EOF
listening-ip=0.0.0.0
listening-port=3478
${EXTERNAL_LINE}
min-port=${MIN_PORT}
max-port=${MAX_PORT}
fingerprint
lt-cred-mech
realm=${REALM}
server-name=${REALM}
user=${TURN_USER}:${TURN_PASS}
no-multicast-peers
no-cli
no-tls
no-dtls
stale-nonce=600
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
verbose
EOF

systemctl enable coturn
systemctl restart coturn

upsert_env TURN_URL "turn:${PUBLIC_IP}:3478"
upsert_env TURN_USERNAME "$TURN_USER"
upsert_env TURN_PASSWORD "$TURN_PASS"

if systemctl list-unit-files | grep -q '^chat-api.service'; then
  log "Restarting chat-api so ICE servers pick up TURN…"
  systemctl restart chat-api
fi

log "Coturn is listening. Add these security-group rules if missing:"
log "  UDP 3478, TCP 3478, UDP ${MIN_PORT}-${MAX_PORT}  from 0.0.0.0/0"
log "TURN_URL=turn:${PUBLIC_IP}:3478"
log "TURN_USERNAME=${TURN_USER}"
log "Check: sudo systemctl status coturn --no-pager"
