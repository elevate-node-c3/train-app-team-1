-- One database per service. Postgres runs everything in
-- /docker-entrypoint-initdb.d exactly once, against an empty data directory:
-- adding a service later needs `docker compose down -v` to re-run this file.
--
-- Deliberately .sql rather than .sh — the entrypoint runs both, and SQL has no
-- shebang for a stray carriage return to break.

CREATE DATABASE catalog;
CREATE DATABASE gateway;
CREATE DATABASE identity;
CREATE DATABASE inventory;
CREATE DATABASE booking;
CREATE DATABASE payment;
CREATE DATABASE notification;
