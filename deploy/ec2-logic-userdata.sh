#!/bin/bash
# Logic tier — FastAPI + Erlang + nginx + Let's Encrypt.
# Paste into EC2 user data (Ubuntu 24.04) AFTER the database instance is up.
set -euxo pipefail
exec > /var/log/chat-logic-userdata.log 2>&1

########################
# CONFIG — edit these
########################
API_DOMAIN="api.techgroupkenya.co.ke"
WS_DOMAIN="ws.techgroupkenya.co.ke"
CERTBOT_EMAIL="cjtechy@gmail.com"
# Amplify URL, no trailing slash (or GitHub Pages origin)
FRONTEND_ORIGIN="https://chat.teralabs.tech"
REPO_URL="https://github.com/cjtechy/Distributed-Chat-Application.git"
# Private IPv4 of the database instance
DB_PRIVATE_IP="10.0.138.219"
# Must be at least 32 characters. Generate: python3 -c "import secrets; print(secrets.token_urlsafe(48))"
SECRET_KEY="K7mN2pQxR9vL4wH8jF6sT1uY0cA3bD5eG7iJ9kM2nP4qS6tV8xZ0aB2dE4fH6jL8nQ0rT2uW4yA6cF8hK0mO2pS4vX6zA8bD0eG2iJ4kM6nP8qS0tV2wY4"
POSTGRES_PASSWORD="xR9mK2pL7vN4wQ8hJ6sT1uY0cA3bD5eG7iJ9k"
REDIS_PASSWORD="zT8nP4qS6vX2wY0aB2dE4fH6jL8mO2pR4uW6yA8cF0hK2"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="cjtechy"
APP_DIR="/opt/chat"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  nginx certbot python3-certbot-nginx \
  python3 python3-venv python3-pip git \
  erlang erlang-dev rebar3 curl dnsutils

git clone "$REPO_URL" "$APP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR"
chmod +x "$APP_DIR/deploy/deploy-backend.sh"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"

cat > "$APP_DIR/backend/.env" <<EOF
HOST=127.0.0.1
PORT=8000
SECRET_KEY=${SECRET_KEY}
JWT_EXPIRE_HOURS=24
COOKIE_SECURE=1
CORS_ORIGINS=${FRONTEND_ORIGIN}
POSTGRES_HOST=${DB_PRIVATE_IP}
POSTGRES_PORT=5432
POSTGRES_USER=chatapp
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}"
POSTGRES_DB=chatapp
POSTGRES_POOL_MIN=2
POSTGRES_POOL_MAX=20
REDIS_HOST=${DB_PRIVATE_IP}
REDIS_PORT=6379
REDIS_PASSWORD="${REDIS_PASSWORD}"
REDIS_DB=0
REDIS_CHAT_CHANNEL=chat:messages
REDIS_INBOUND_CHANNEL=chat:inbound
REDIS_ONLINE_KEY=chat:online_users
REDIS_USERNAME_KEY=chat:usernames
MAX_GROUP_USERS=1000
ERLANG_WS_PORT=8080
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

cat > /etc/systemd/system/chat-api.service <<EOF
[Unit]
Description=Distributed Chat FastAPI
After=network.target
[Service]
WorkingDirectory=${APP_DIR}/backend
ExecStart=${APP_DIR}/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > "$APP_DIR/erlang-messaging/start-linux.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
rebar3 compile
EBINS=$(find _build/default/lib -type d -name ebin | tr '\n' ' ')
exec erl -noshell -noinput -config config/sys.config -pa $EBINS \
  -eval 'application:ensure_all_started(chat_messaging).'
EOF
chmod +x "$APP_DIR/erlang-messaging/start-linux.sh"

cat > /etc/systemd/system/chat-ws.service <<EOF
[Unit]
Description=Distributed Chat Erlang
After=network.target
[Service]
WorkingDirectory=${APP_DIR}/erlang-messaging
Environment=DOTENV_PATH=${APP_DIR}/backend/.env
Environment=HOME=/root
ExecStart=${APP_DIR}/erlang-messaging/start-linux.sh
Restart=always
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now chat-api chat-ws

cat > /etc/sudoers.d/chat-deploy <<'EOF'
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl restart chat-api, /bin/systemctl restart chat-ws, /bin/systemctl status chat-api, /bin/systemctl status chat-ws, /bin/systemctl is-active chat-api, /bin/systemctl is-active chat-ws
EOF
chmod 440 /etc/sudoers.d/chat-deploy

cat > /etc/nginx/sites-available/api <<EOF
server {
    listen 80;
    server_name ${API_DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

cat > /etc/nginx/sites-available/ws <<EOF
server {
    listen 80;
    server_name ${WS_DOMAIN};
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/api /etc/nginx/sites-enabled/api
ln -sf /etc/nginx/sites-available/ws /etc/nginx/sites-enabled/ws
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
for i in $(seq 1 60); do
  [ "$(dig +short "$API_DOMAIN" | tail -n1)" = "$PUBLIC_IP" ] && \
  [ "$(dig +short "$WS_DOMAIN" | tail -n1)" = "$PUBLIC_IP" ] && break
  sleep 15
done

certbot --nginx -d "$API_DOMAIN" -d "$WS_DOMAIN" \
  --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
