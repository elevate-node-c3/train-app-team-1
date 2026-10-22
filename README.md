# train-app-team-1

A NestJS monorepo holding seven services and three shared libraries, with all
of its infrastructure defined in Compose. The whole stack comes up with one
command.

> **The services are empty by design.** Each one boots, listens on `PORT`, and
> exposes nothing — no routes, no health endpoint, no config validation, no
> response envelope, no logging shape. This is the wireframe: the shape every
> service will share, with nothing in it yet. Health endpoints, configuration
> validation and the response envelope arrive in the next story, and the
> event-driven messaging backbone (transactional outbox, relay, idempotent
> consumers, dead-lettering) in the one after. A service with no routes is
> finished work here, not broken work.

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

### What comes up

Compose starts four infrastructure containers, waits for each to report
healthy, and only then starts the seven services.

| | Host address | Notes |
| --- | --- | --- |
| Gateway | <http://localhost:3000> | Returns 404 — it has no routes yet. That the port answers is the point. |
| RabbitMQ management | <http://localhost:15672> | Sign in with `RABBITMQ_USER` / `RABBITMQ_PASSWORD` from `.env`. |
| Mailpit inbox | <http://localhost:8025> | Every mail the stack sends lands here instead of being delivered. |
| Postgres | *not published* | Reachable only from inside the Compose network. |
| Redis | *not published* | Reachable only from inside the Compose network. |

The other six services are deliberately unreachable from the host. They talk to
each other over the Compose network, and anything the outside world needs goes
through the gateway.

Every published port comes from a variable in `.env` — if something already
owns 3000, 15672 or 8025 locally, change `GATEWAY_PORT`,
`RABBITMQ_MANAGEMENT_PORT` or `MAILPIT_UI_PORT` there rather than editing
`docker-compose.yml`.

### One database per service

There is one Postgres container holding seven databases, one per service, each
named after its service. A service's `DATABASE_URL` points only at its own.

## Working on the host

```bash
npm install
npm run start:dev <service>     # e.g. npm run start:dev booking
npm run build <service>         # omit the name to build everything
```

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
npm test          # the suite
npm run test:cov  # with coverage
npm run lint
npm run format
```

The suite is the skeleton's own guard rail. It asserts that the seven apps and
three libs stay registered, that the path aliases really resolve, that every
compose service builds from the shared `Dockerfile` with its own `APP` argument
and waits for healthy infrastructure, that only the gateway publishes a port,
and that every variable `docker-compose.yml` interpolates is documented in
`.env.example`. Add a service and forget a step, and a test says which one.

## Resetting the databases

**Postgres runs `docker/postgres/init/01-create-databases.sql` exactly once:
against an empty data directory.** Once the volume exists, the script is never
run again — so if you add a service after having already started the stack, its
database will not exist, and it will fail to connect for a reason that looks
nothing like the cause.

Adding a service, or any other change to that init script, means destroying the
volume:

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
