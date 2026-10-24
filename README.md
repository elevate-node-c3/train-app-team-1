# train-app-team-1

A NestJS monorepo holding seven services and three shared libraries, with all
of its infrastructure defined in Compose. The whole stack comes up with one
command.

> **Platform Skeleton Complete**: All seven services boot with vertical slices (transport, domain, persistence via TypeORM), validate configuration at startup with Joi fail-fast schemas, communicate internally over gRPC with proto definitions, expose liveness and readiness health checks, speak one standardized Arabic/English response envelope, and emit single-line JSON logs carrying a trace correlation ID with automatic PII redaction.

## The services

| Service | Role |
| --- | --- |
| `gateway` | The single entry point from outside. The only service that publishes a host port. |
| `identity` | Accounts, authentication, authorization. |
| `catalog` | Trains, routes, schedules — what can be booked. |
| `inventory` | Seat and capacity availability for a given departure. |
| `booking` | Reservations and their lifecycle. |
| `payment` | Charges, refunds, and payment state. |
| `notification` | Outbound email and messaging. The only service wired to a mail server. |

Three shared libraries back them, importable by path alias:

| Alias | Holds |
| --- | --- |
| `@app/contracts` | Event and message shapes shared between services. |
| `@app/messaging` | Broker plumbing: publishing, consuming, retry. |
| `@app/common` | Cross-cutting pieces that are not domain-specific. |

They are empty modules with barrel exports for now, so that the import paths
are real before there is anything to import.

## Prerequisites

- **Docker Desktop** — the only thing you need to run the stack.
- **Node 24** — only if you want to run a service or the tests on the host.

## Getting started

```bash
cp .env.example .env
docker compose up
```

That is the whole setup. The first run builds seven images and takes a few
minutes; later runs are cached.

Every variable also has the same default baked into `docker-compose.yml`, so
`docker compose up` on its own works too — copying `.env` is what lets you
change ports or credentials.

### What comes up

Compose starts four infrastructure containers, waits for each to report
healthy, and only then starts the seven services.

| | Host address | Notes |
| --- | --- | --- |
| Gateway | <http://localhost:3000> | Returns 404 — it has no routes yet. That the port answers is the point. |
| RabbitMQ management | <http://localhost:15672> | Sign in with `RABBITMQ_USER` / `RABBITMQ_PASSWORD` from `.env`. Bound to localhost only. |
| Mailpit inbox | <http://localhost:8025> | Every mail the stack sends lands here instead of being delivered. Bound to localhost only. |
| Postgres | *not published* | Reachable only from inside the Compose network. |
| Redis | *not published* | Reachable only from inside the Compose network. |

The other six services are deliberately unreachable from the host. They talk to
each other over the Compose network, and anything the outside world needs goes
through the gateway.

Every published port comes from a variable in `.env` — if something already
owns 3000, 15672 or 8025 locally, change `GATEWAY_PORT`,
`RABBITMQ_MANAGEMENT_PORT` or `MAILPIT_UI_PORT` there rather than editing
`docker-compose.yml`.

### One database — and one set of credentials — per service

There is one Postgres container holding seven databases, one per service, each
named after its service. Each service also has **its own login role**, which
owns its own database and **cannot open any other one**. A service's
`DATABASE_URL` therefore carries only its own credentials, so a bug or a
compromise in one service cannot read another's data.

Two details worth knowing, because neither is obvious:

- Creating a role per service is not sufficient on its own. Postgres grants
  `CONNECT` on a new database to `PUBLIC`, so the init script also has to
  `REVOKE CONNECT ... FROM PUBLIC` on each one. Without that line every role
  can open every database.
- Each role **owns** its database, so it has full DDL rights there and can run
  its own migrations without any extra grant. No service can touch another's
  schema.

The Postgres superuser (`POSTGRES_USER`) is used only for administration, the
healthcheck, and creating the above. No service holds those credentials.

Changing a service's password after the first start needs
`docker compose down -v`, because the roles are created once (see below).

## Working on the host

```bash
npm install
npm run start:dev <service>     # e.g. npm run start:dev booking
npm run build <service>         # omitting the name builds only the gateway,
                                # which is the default project
```

`dist/` holds **one app at a time**: the build wipes the output directory
first, and all ten projects emit into the same root `dist/`. That is what the
images want — one app per image, built fresh — but on the host it means
`npm run build booking` followed by `npm run start:prod` fails with a missing
module, because `start:prod` runs the gateway and the booking build removed it.
Build the app you intend to run.

A service run this way still expects its infrastructure, so leave the
infrastructure containers up while you do it:

```bash
docker compose up -d postgres redis rabbitmq mailpit
```

Note that the host-side `DATABASE_URL`, `REDIS_URL` and `RABBITMQ_URL` would
need to point at `localhost` rather than the Compose service names, and
Postgres and Redis publish no host ports — so for now the fully containerized
path is the supported one.

## Tests

```bash
npm test          # the suite — no Docker needed
npm run test:cov  # with coverage
npm run lint
npm run format
```

```bash
npm run test:e2e  # needs Docker, and RESETS the local database volumes
```

The e2e suite proves the per-service database credentials really are isolated,
which can only be checked against a live Postgres created from an empty data
directory — so it runs `docker compose down -v` before and after. Don't run it
against a stack whose data you want to keep.

The suite is the skeleton's own guard rail. It asserts that the seven apps and
three libs stay registered, that the path aliases really resolve, that every
compose service builds from the shared `Dockerfile` with its own `APP` argument
and waits for healthy infrastructure, that only the gateway publishes a port,
and that every variable `docker-compose.yml` interpolates is documented in
`.env.example`. Add a service and forget a step, and a test says which one.

## Resetting the databases

**Postgres runs `docker/postgres/init/01-create-databases.sh` exactly once:
against an empty data directory.** Once the volume exists, the script is never
run again — so if you add a service after having already started the stack, its
database and role will not exist, and it will fail to connect for a reason that
looks nothing like the cause. The same applies to changing a password in
`.env`: the role already exists with the old one.

Adding a service, changing a service password, or any other change to that init
script means destroying the volume:

```bash
docker compose down -v    # -v is the part that matters: it drops the volumes
docker compose up --build
```

`docker compose down` without `-v` keeps your data and is what you want for an
ordinary stop.

## How the images are built

All seven services are built from the one root `Dockerfile`, which takes the
app name as a build argument:

```bash
docker build --build-arg APP=gateway -t train-app/gateway .
```

`docker-compose.yml` passes that argument per service. There is deliberately
no second Dockerfile — a new service needs an entry in `nest-cli.json` and one
in `docker-compose.yml`, and nothing else.

## Reviewer Flow & Demo Scenarios

### Happy Path
1. Boot the stack:
   ```bash
   cp .env.example .env
   docker compose up --build -d
   ```
2. Verify all infrastructure and seven services are healthy:
   ```bash
   docker compose ps
   ```
3. Test Gateway health aggregation and bilingual response envelope:
   ```bash
   curl -i -H "Accept-Language: ar" http://localhost:3000/health
   ```
   *Expected:* Unified envelope with Arabic message, status `ready`, and a generated `correlationId`.
4. Trace correlation ID across all services:
   ```bash
   # Extract correlationId from the response and grep logs:
   docker compose logs | grep "<correlation-id>"
   ```
   *Expected:* Log lines from gateway and all downstream services carrying that exact correlation ID in single-line JSON format, with sensitive credentials and personal data (passwords, tokens, PINs, card numbers, unmasked emails) redacted.

### Unhappy Demo Paths
1. **Configuration Fails Fast**: Remove a required variable from identity's environment:
   ```bash
   docker compose run --rm -e DATABASE_URL="" identity
   ```
   *Expected:* Identity refuses to boot, prints `Configuration error: Missing required environment variable 'DATABASE_URL'`, never prints secret values, and exits with code 1.
2. **Postgres Outage Recovery**:
   ```bash
   docker compose stop postgres
   curl -i http://localhost:3000/health
   ```
   *Expected:* Gateway reports downstream services not ready (HTTP 503).
   ```bash
   docker compose start postgres
   curl -i http://localhost:3000/health
   ```
   *Expected:* Services automatically recover on their own and report ready again.
3. **Redis Outage (Degraded, Not Dead)**:
   ```bash
   docker compose stop redis
   curl -i http://localhost:3000/health
   ```
   *Expected:* Services keep answering (HTTP 200), reporting status `degraded` and `redis: "unavailable"`.
4. **Graceful Shutdown**:
   ```bash
   docker compose stop identity
   ```
   *Expected:* Service stops accepting new traffic, finishes in-flight requests, closes connections, and exits cleanly with code 0.

## Postman Collection

A complete Postman Collection and Environment are provided in `postman/`:

- **Collection**: [`postman/train-app-platform.postman_collection.json`](file:///d:/Elevate/Projects/train-app-team-1/postman/train-app-platform.postman_collection.json)
- **Environment**: [`postman/train-app-local.postman_environment.json`](file:///d:/Elevate/Projects/train-app-team-1/postman/train-app-local.postman_environment.json)

### Importing into Postman
1. Open Postman -> click **Import**.
2. Select both JSON files from the `postman/` folder.
3. Select the **Train App - Local Environment** active environment.
4. Execute queries against Gateway (`/health`, `/health/ready`, `/health/live`, `/api/ping-all`) or standalone microservice health endpoints. Built-in test scripts validate status codes, bilingual envelopes, and extract the correlation ID header automatically.

