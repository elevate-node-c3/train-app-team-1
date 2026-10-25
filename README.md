# train-app-team-1

A NestJS monorepo holding seven services and three shared libraries, with all
of its infrastructure defined in Compose. The whole stack comes up with one
command.

> **Platform Skeleton Complete**: All seven services boot with vertical slices (transport, domain, persistence via TypeORM), validate configuration at startup with Joi fail-fast schemas, communicate internally over gRPC with proto definitions, expose liveness and readiness health checks, speak one standardized Arabic/English response envelope, and emit single-line JSON logs carrying a trace correlation ID with automatic PII redaction.
>
> **Event backbone complete**: `POST /api/v1/auth/sign-up` commits the account, the code hash, and an outbox event in one Postgres transaction. A relay publishes to RabbitMQ; notification consumes idempotently and sends the email through Mailpit, with TTL retry queues, a dead-letter queue, and a 30-second BR-03 latency gate.
>
> **Authentication complete**: the verification code completes sign-up and returns the first RS256 token pair. The gateway enforces deny-by-default JWT access, shared rate limits, and prompt session revocation; sign-in, refresh rotation with a 10-second replay window, sign-out and password recovery are live under `/api/v1/auth`.

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
| `@app/contracts` | Shapes crossing a service boundary: the HTTP `ApiResponse`, `ErrorCode`, health DTOs, the protobuf contracts, password policy, access-token claims and event envelopes/payloads. No logic, no DI, no I/O. |
| `@app/messaging` | RabbitMQ plumbing: connection, topology, transactional outbox and relay, publishing, the idempotent consumer runtime, TTL retry queues and the DLQ. |
| `@app/common` | Cross-cutting: `setupApp`, Joi env validation, correlation (CLS + `x-correlation-id`), pino + PII redaction, the response envelope and exception filter, i18n, health, TypeORM config, the unit of work, the migration runner, the shared Redis client, and the RS256 access-token signer/verifier. |

Contracts holds only shapes; the other two carry implementations, so a service
can add a consumer without depending on another service.

## Prerequisites

- **Docker Desktop** — the only thing you need to run the stack.
- **Node 24** — only if you want to run a service or the tests on the host.

## Getting started

```bash
cp .env.example .env
docker compose up
```

That is the whole setup. The first run builds seven app images plus the one-shot
seed image and takes a few minutes; later runs are cached. Compose also runs a
one-shot `identity-seed` service after identity starts; it creates the BR-01
operator and conductor accounts. Running it again is safe: it reports both
accounts as already present.

Every variable also has the same default baked into `docker-compose.yml`, so
`docker compose up` on its own works too — copying `.env` is what lets you
change ports or credentials.

### What comes up

Compose starts four infrastructure containers, waits for each to report
healthy, starts the seven application services, and runs the one-shot staff
seed.

| | Host address | Notes |
| --- | --- | --- |
| Gateway | <http://localhost:3000> | `POST /api/v1/auth/*`, `GET /health`, `/health/live`, `/health/ready`, `GET /api/v1/ping-all`. The only app port. |
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

The four infrastructure containers have healthchecks; the seven app containers
do not. `docker compose up --wait` therefore says nothing about application
readiness. Poll `/health/ready` before using the stack, and for the event
backbone also confirm the consumer attached — see
[Reviewer Flow & Demo Scenarios](#reviewer-flow--demo-scenarios).

### How sign-up works

`POST /api/v1/auth/sign-up` crosses the gateway synchronously, then becomes
asynchronous:

1. The gateway validates `{ email, password, language? }` and calls identity
   over gRPC.
2. Identity hashes the password with bcrypt, generates a six-digit code, and
   commits the account, the password hash, the verification-code hash (salted
   scrypt — never plaintext), the resend counter, and the outbox rows in one
   Postgres transaction. The HTTP response returns here. Nothing has been
   published and no email has been sent.
3. Identity's relay claims the rows with `FOR UPDATE SKIP LOCKED`, publishes
   them to the `train.events` topic exchange, waits for the broker confirm, and
   only then marks `published_at`.
4. Notification consumes from its own durable queue, claims the envelope id in
   `processed_event` for idempotency, and sends the verification email over
   SMTP to Mailpit. A transient failure goes to per-attempt TTL retry queues
   (1s / 3s / 9s), then the DLQ. A code older than
   `VERIFICATION_CODE_TTL_SECONDS` is recorded as skipped and not emailed.
   The `account.registered` event deliberately sends no mail; the code email is
   driven by `verification-code.issued`, which carries the code and its TTL.

Two properties follow: stopping notification or RabbitMQ does not fail a
sign-up, and a duplicate delivery produces one email.
[Reviewer Flow & Demo Scenarios](#reviewer-flow--demo-scenarios) has the
operator commands and the failure demos; `test/e2e/` runs the same demos
non-interactively against the real stack.

### How authentication works

Every auth route lives under `/api/v1/auth` on the gateway. Only `sign-out` is
protected; the rest are explicitly public because the gateway guard denies any
route that does not declare `@Public()` or an access level.

| Route | Purpose | Success |
| --- | --- | --- |
| `POST /sign-up` | Create a pending account and email a code. | `201` |
| `POST /verify-email` | Consume the code, activate the account, mint the first token pair. | `200` |
| `POST /resend-verification` | Issue a fresh sign-up code, subject to the durable resend window. | `200` |
| `POST /sign-in` | Password check; pending accounts get `verificationRequired: true` and no tokens. | `200` |
| `POST /refresh` | Rotate the refresh token and mint a new access token. | `200` |
| `POST /sign-out` | Revoke the caller's session and tokens. Requires `Authorization: Bearer`. | `200` |
| `POST /forgot-password` | Email a reset code, or answer identically when the address is unknown. | `202` |
| `POST /reset-password` | Consume the reset code, change the password and revoke every session. | `200` |

The token model:

- **Access tokens are RS256 and short-lived** (15 minutes by default). Identity
  holds the private key; the gateway receives only the public half, so a
  compromised edge cannot mint a token. Tokens carry `kid`, and the verifier
  also accepts the configured previous key, which makes rotation
  zero-downtime. `alg: none` and algorithm confusion are rejected.
- **Claims are authorization facts, not a profile**: `sub`, `lvl`, `roles`,
  `sid`, `jti`, `bkbl`, plus `iss`/`aud`/`iat`/`exp`. No email, name, phone or
  other directly identifying value is placed in a token.
- **Refresh tokens are stored only as SHA-256 hashes** and slide for 30 days.
  Rotation marks the old row before inserting its successor. A replay within
  the 10-second grace window returns the sealed successor pair; a reuse after
  that window is treated as theft and revokes the whole session.
- **Revocation is prompt and durable**: sign-out and password reset append a
  `session.revoked` event in the same transaction. The gateway consumes it and
  writes Redis markers (a session or token marker for sign-out, an
  account-level `revokedAt` marker for reset). Revocation lookups fall back to
  process memory; if Redis is down they fail open and readiness reports
  `degraded`, because an unavailable cache must not take the API down. Access
  tokens are short-lived, so the exposure is bounded.
- **Abuse controls are layered**. The gateway applies shared Redis-backed
  limits per route and falls back to half the configured limit per process when
  Redis is unavailable. Identity still owns the authoritative Postgres
  counters: the 120-second resend window, the five-per-hour cap, per-code
  attempt limits, and the sign-in lockout. `forgot-password` answers
  identically for known and unknown addresses, including the same
  `secondsRemaining`.

The committed development RSA pair is under `config/jwt/` and is the runtime
default. Production must inject `JWT_PRIVATE_KEY` (identity only) and
`JWT_PUBLIC_KEY` (gateway) and should set a real `TOKEN_GRACE_SECRET`; see
`.env.example`.

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
then drives the event backbone end to end: demo 1 (notification stopped, sign-up
still answers, email arrives on restart), demo 2 (a republished envelope yields
exactly one email), demo 1b (broker stopped, the outbox publishes on recovery),
and a 25-sign-up latency run that gates BR-03 at p95 and worst case under 30s.
`test/e2e/auth.e2e-spec.ts` adds the full auth flow against the same stack:
sign-up → read the code from Mailpit → verify → sign-in → refresh rotation and
grace replay → sign-out → revoked-token rejection, then password reset
revoking both live sessions through the account-level marker. The outbox specs
start only the backbone's slice of Compose, wait on service readiness and the
broker's consumer count, and run specs serially (`fileParallelism: false`). The
suite runs `docker compose down -v` before and after — so don't point it at
data you want to keep.

The unit and skeleton suites are the skeleton's own guard rail. They assert
that the seven apps and three libs stay registered, that the path aliases really
resolve, that every compose service builds from the shared `Dockerfile` with
its own `APP` argument and waits for healthy infrastructure, that only the
gateway publishes a port, and that every variable `docker-compose.yml`
interpolates is documented in `.env.example`. Add a service and forget a step,
and a test says which one.

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
2. Verify infrastructure health and application readiness:
   ```bash
   docker compose ps            # the four infra containers report healthy
   curl -s http://localhost:3000/health/ready
   ```
   *Expected:* the four infrastructure containers report `healthy`, and the
   readiness report's top-level `status` is `ready`. The route reports rather
   than returning `503`, so read the field. The seven app containers have no
   Compose healthcheck, so `ps` alone is not enough. The one-shot
   `identity-seed` container exits after creating (or finding) the operator and
   conductor accounts; `docker compose up` runs it for you. If identity and
   Postgres run on the host instead, seed by hand with `npm run seed:staff`.
   The development credentials are `operator@train.local` / `Operator!Dev123`
   and `conductor@train.local` / `Conductor!Dev123` unless `.env` overrides the
   seed password variables.
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
5. Sign up and watch the verification email arrive:
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/sign-up \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer@example.com","password":"Str0ng!Passw0rd","language":"en"}'
   ```
   *Expected:* `201` with the bilingual response envelope and a masked email.
   The account, password hash, code hash, resend counter and outbox events
   committed together; within about a second the email appears at
   <http://localhost:8025>. `language: "en"` selects the English body; `"ar"`
   or an omitted `language` uses Arabic. The password must satisfy BR-02: at
   least 8 characters, a letter, a digit and a symbol.
6. Verify the code and receive the first token pair:
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/verify-email \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer@example.com","code":"123456"}'
   ```
   *Expected:* `200` with `accessToken`, `refreshToken`, `tokenType: "Bearer"`
   and the account id. A wrong code returns `INVALID_VERIFICATION_CODE` and
   still consumes an attempt; a verified account can sign in:
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/sign-in \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer@example.com","password":"Str0ng!Passw0rd"}'
   ```
7. Rotate, then revoke, a session:
   ```bash
   ACCESS='<accessToken from verify-email or sign-in>'
   REFRESH='<refreshToken>'

   curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
     -H 'content-type: application/json' \
     -d "{\"refreshToken\":\"$REFRESH\"}"

   curl -s -X POST http://localhost:3000/api/v1/auth/sign-out \
     -H 'content-type: application/json' \
     -H "authorization: Bearer $ACCESS" \
     -d "{\"refreshToken\":\"$REFRESH\"}"
   ```
   *Expected:* refresh returns a new pair; sign-out returns
   `{ "revoked": true }`. Reusing the old access token returns `401` with
   `TOKEN_REVOKED` once the gateway has consumed the revocation event (usually
   within a second). Reusing the refresh token returns `SESSION_REVOKED`.
8. Recover a password:
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/forgot-password \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer@example.com"}'
   ```
   *Expected:* `202` whether or not the address exists. Read the six-digit
   reset code from Mailpit, then:
   ```bash
   curl -s -X POST http://localhost:3000/api/v1/auth/reset-password \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer@example.com","code":"654321","newPassword":"N3w!Passw0rd"}'
   ```
   *Expected:* `200` with `{ "reset": true }`. Every session and refresh token
   for the account is revoked, including sessions that did not request the
   reset; the old password no longer signs in.
9. Prove the async hop is not a lost update:
   ```bash
   docker compose stop notification
   curl -s -X POST http://localhost:3000/api/v1/auth/sign-up \
     -H 'content-type: application/json' \
     -d '{"email":"reviewer-2@example.com","password":"Str0ng!Passw0rd","language":"ar"}'
   docker compose start notification
   ```
   *Expected:* the second sign-up still returns `201` immediately; the email
   arrives once notification restarts. The full set of failure demos is in
   [Unhappy Demo Paths](#unhappy-demo-paths) below.

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

- **Collection**: [`postman/train-app-platform.postman_collection.json`](postman/train-app-platform.postman_collection.json)
- **Environment**: [`postman/train-app-local.postman_environment.json`](postman/train-app-local.postman_environment.json)

### Importing into Postman
1. Open Postman -> click **Import**.
2. Select both JSON files from the `postman/` folder.
3. Select the **Train App - Local Environment** active environment.
4. Execute queries against Gateway (`/health`, `/health/ready`, `/health/live`, `/api/v1/ping-all`, `/api/v1/auth/*`) or standalone microservice health endpoints. Built-in test scripts validate status codes, bilingual envelopes, and extract the correlation ID, account id, and token pair into environment variables automatically.

