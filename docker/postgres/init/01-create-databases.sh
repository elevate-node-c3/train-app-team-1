#!/bin/sh
# Each service owns one database and cannot open others.
# Runs on first start only. Adding a service needs a local data reset:
# `docker compose down -v` deletes the existing data.
# Use a shell for environment passwords; keep LF line endings.

set -eu

# Let psql quote names and passwords to avoid SQL injection.
create_service_database() {
  service="$1"
  password="$2"

  if [ -z "$password" ]; then
    echo "init: no password set for service '$service'; refusing to create a role without one" >&2
    exit 1
  fi

  echo "init: creating role and database for '$service'"

  psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=service="$service" \
    --set=password="$password" <<'EOSQL'
CREATE ROLE :"service" LOGIN PASSWORD :'password';
CREATE DATABASE :"service" OWNER :"service";
REVOKE CONNECT ON DATABASE :"service" FROM PUBLIC;
EOSQL
}

create_service_database catalog "${CATALOG_DB_PASSWORD:-}"
create_service_database gateway "${GATEWAY_DB_PASSWORD:-}"
create_service_database identity "${IDENTITY_DB_PASSWORD:-}"
create_service_database inventory "${INVENTORY_DB_PASSWORD:-}"
create_service_database booking "${BOOKING_DB_PASSWORD:-}"
create_service_database payment "${PAYMENT_DB_PASSWORD:-}"
create_service_database notification "${NOTIFICATION_DB_PASSWORD:-}"
