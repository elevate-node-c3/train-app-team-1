#!/bin/sh
# One login role and one database per service, each role owning its own
# database and able to open no other.
#
# Runs exactly once, against an empty data directory. Adding a service here
# means `docker compose down -v` before the new database exists.
#
# This is a .sh rather than a .sql because each service's password comes from
# the environment and .sql cannot interpolate it. The usual hazard with a shell
# script in this directory is a CRLF line ending breaking the shebang;
# .gitattributes pins *.sh to LF.

set -eu

# Identifiers are interpolated by psql as quoted identifiers (:"service") and
# the password as a quoted literal (:'password'), so neither is pasted into SQL
# text by the shell.
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
