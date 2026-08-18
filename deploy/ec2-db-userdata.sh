#!/bin/bash
# Database tier — PostgreSQL + Redis. Paste into EC2 user data (Ubuntu 24.04).
# Launch this instance first. Copy its Private IPv4 into ec2-logic-userdata.sh.
set -euxo pipefail
exec > /var/log/chat-db-userdata.log 2>&1

########################
# CONFIG — edit these
########################
POSTGRES_PASSWORD="xR9mK2pL7vN4wQ8hJ6sT1uY0cA3bD5eG7iJ9k"
REDIS_PASSWORD="zT8nP4qS6vX2wY0aB2dE4fH6jL8mO2pR4uW6yA8cF0hK2"
# VPC IPv4 CIDR (EC2 → VPC). Used in pg_hba; security groups still do the real filtering.
VPC_CIDR="10.0.0.0/16"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql redis-server

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chatapp') THEN
    CREATE USER chatapp WITH PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE chatapp OWNER chatapp'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'chatapp')\gexec
SQL

PG_CONF=$(find /etc/postgresql -name postgresql.conf | head -n1)
HBA=$(find /etc/postgresql -name pg_hba.conf | head -n1)
sed -i "s/^#\?listen_addresses.*/listen_addresses = '*'/" "$PG_CONF"
grep -q "chatapp ${VPC_CIDR}" "$HBA" || \
  echo "host chatapp chatapp ${VPC_CIDR} scram-sha-256" >> "$HBA"
systemctl enable --now postgresql
systemctl restart postgresql

sed -i 's/^bind .*/bind 0.0.0.0/' /etc/redis/redis.conf
sed -i 's/^#\?requirepass .*/requirepass '"${REDIS_PASSWORD}"'/' /etc/redis/redis.conf
grep -q "^requirepass " /etc/redis/redis.conf || echo "requirepass ${REDIS_PASSWORD}" >> /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server
