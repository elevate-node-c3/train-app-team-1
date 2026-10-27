# Platform Skeleton & Authentication Verification Walkthrough

This document records the verification evidence for the **Platform Skeleton** and the **Authentication (AUTH-1/AUTH-2/AUTH-3)** stories: seven microservices (`gateway`, `catalog`, `identity`, `inventory`, `booking`, `payment`, `notification`) booting, reporting their health, speaking one unified language of errors and responses, and enforcing a complete account and session lifecycle at the gateway.

---

## 1. Summary of Delivered Architecture

1. **Monorepo & Multi-Service Topology**:
   - 7 NestJS microservices (`apps/`) using module-first feature slices: `src/modules/<feature>/` with a root `<feature>.module.ts`, concrete `controllers/`, `services/`, `repositories/`, `consumers/` and `entities/`, plus app-level `config/` and `database/`.
   - 3 shared libraries (`libs/`):
     - `@app/contracts`: Unified response envelope DTO, health models, error codes enum, and gRPC proto contracts (`health.proto`, plus `identity.proto` under `train.identity.v1` with `IdentityService`).
     - `@app/messaging`: Direct AMQP client via `amqplib` with connection recovery, exclusive probe health checks, and cross-service correlation header propagation.
     - `@app/common`: Joi fail-fast environment validation with secret masking, Pino structured JSON logging with ISO timestamps and PII redaction, AsyncLocalStorage correlation tracking via `ClsService`, bilingual response envelope/error filter (Arabic default fallback `ar`, English via `Accept-Language: en`), gRPC health server/client with downstream aggregation, and graceful shutdown handling (`SIGTERM`/`SIGINT`).
   - Persistence is **TypeORM** in every service, including notification's entity-backed `email_delivery` log (`manualInitialization: true` for zero-host-dependency unit testing).

2. **Automated Test Suite**:
   - **48 test files passed** (471 passed, 1 skipped).
   - Covers compose structure, library exports, application builds, Joi environment schema fail-fast validations, response envelopes and i18n, correlation propagation, Pino PII redaction, health & degraded mode, module-first convention checks (banned layers/ports/use-cases, concrete repositories, pure entities, `process.env` limits), and every authentication service, guard, store, consumer and gRPC adapter.
   - The real Compose stack is exercised by five e2e specs (25 tests total), including the complete auth lifecycle, staff-role isolation and password recovery flow.

3. **Authentication & Session Lifecycle**:
   - Identity owns bcrypt password hashes, verification codes (scrypt-hashed), Postgres-backed counters and RS256 signing; the gateway holds only the public key and denies unannotated routes by default.
   - Identity's gRPC contract is `train.identity.v1` / `IdentityService` in `identity.proto`, renamed from `train.auth.v1` / `AuthService` (formerly `train.accounts.v1` / `AccountsService`); gateway and identity must deploy together.
   - Sign-up, pending sign-in, email verification, refresh rotation with a 10-second replay grace window, sign-out, and password recovery run through `POST /api/v1/auth/*`.
   - A standalone TypeScript seed creates one verified operator and one conductor without using a migration; Compose runs it as a one-shot after identity starts, and the e2e harness reuses the same seed data.
   - Session revocation travels through the outbox to a gateway consumer and is applied as Redis markers, with an in-process fallback when Redis is degraded.

---

## 2. Test Suite Execution Evidence

Command run:
```bash
npm test
```

Output:
```text
> train-app-team-1@0.0.1 test
> vitest run

 RUN  v4.1.12 D:/projects/Elevate/train-app-team-1

 Test Files  48 passed (48)
      Tests  471 passed | 1 skipped (472)
   Duration  22.87s
```

Lint is also clean:

```text
> train-app-team-1@0.0.1 lint
> oxlint --type-aware apps/ libs/ test/
```

---

## 3. Reviewer Verification Demos

### Demo 1: Happy Path — Unified Envelope & Health Reporting

**Command (Arabic default fallback):**
```bash
curl -i http://localhost:3000/health
```

**HTTP Response:**
```http
HTTP/1.1 200 OK
x-correlation-id: 340177b6-4297-4e20-bf5d-7596ab5b081b
Content-Type: application/json; charset=utf-8

{
  "success": true,
  "data": {
    "status": "ready",
    "gateway": {
      "service": "gateway",
      "status": "ready",
      "dependencies": {
        "database": { "status": "ready" },
        "broker": { "status": "ready" },
        "redis": { "status": "ready" }
      },
      "timestamp": "2026-10-23T18:20:10.385Z"
    },
    "services": {
      "catalog": { "service": "catalog", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } },
      "identity": { "service": "identity", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } },
      "inventory": { "service": "inventory", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } },
      "booking": { "service": "booking", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } },
      "payment": { "service": "payment", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } },
      "notification": { "service": "notification", "status": "ready", "dependencies": { "database": { "status": "ready" }, "broker": { "status": "ready" }, "redis": { "status": "ready" } } }
    },
    "timestamp": "2026-10-23T18:20:11.277Z"
  },
  "message": "تمت العملية بنجاح",
  "error": null,
  "correlationId": "340177b6-4297-4e20-bf5d-7596ab5b081b",
  "timestamp": "2026-10-23T18:20:11.278Z"
}
```

**Command (English via `Accept-Language`):**
```bash
curl -i -H "Accept-Language: en" http://localhost:3000/health
```
```json
{
  "success": true,
  "data": { ... },
  "message": "Operation completed successfully",
  "error": null,
  "correlationId": "bc928d17-e4d0-4bc3-97fc-a7c984f24014",
  "timestamp": "2026-10-23T18:20:16.258Z"
}
```

---

### Demo 2: Correlation ID Distributed Tracing

Invoking the gateway aggregation endpoint (`/api/v1/ping-all`) generates a correlation ID (`8f84e497-03cc-41e4-af42-fe42d83e5840`) which is forwarded across gRPC metadata to all downstream services.

**Command:**
```bash
docker compose logs --no-color | Select-String "8f84e497-03cc-41e4-af42-fe42d83e5840"
```

**Log Output:**
```json
gateway-1       | {"level":"info","time":"2026-10-23T18:23:08.852Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to catalog"}
catalog-1       | {"level":"info","time":"2026-10-23T18:23:08.858Z","service":"catalog","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: catalog"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:08.907Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to identity"}
identity-1      | {"level":"info","time":"2026-10-23T18:23:08.912Z","service":"identity","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: identity"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:08.961Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to inventory"}
inventory-1     | {"level":"info","time":"2026-10-23T18:23:08.967Z","service":"inventory","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: inventory"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:09.017Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to booking"}
booking-1       | {"level":"info","time":"2026-10-23T18:23:09.021Z","service":"booking","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: booking"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:09.071Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to payment"}
payment-1       | {"level":"info","time":"2026-10-23T18:23:09.075Z","service":"payment","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: payment"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:09.120Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"GatewayHealthService","msg":"Dispatching gRPC health check to notification"}
notification-1  | {"level":"info","time":"2026-10-23T18:23:09.123Z","service":"notification","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","context":"HealthGrpcController","msg":"Received health check for service: notification"}
gateway-1       | {"level":"info","time":"2026-10-23T18:23:09.171Z","service":"gateway","correlationId":"8f84e497-03cc-41e4-af42-fe42d83e5840","res":{"statusCode":null},"responseTime":363,"msg":"request completed"}
```
All seven services participate in a single coherent trace.

---

### Demo 3: Unhappy Path — Fail-Fast Configuration Validation

**Command:**
```bash
docker compose run --rm -e DATABASE_URL="" identity
```

**Output:**
```text
[identity] Configuration error: Invalid variable 'DATABASE_URL' ([REDACTED]): [REDACTED] is not allowed to be empty
```
**Exit Code:** `1`
- Names the missing/invalid variable (`DATABASE_URL`).
- Masks all secret values (`[REDACTED]`).
- Exits immediately with non-zero status.

---

### Demo 4: Unhappy Path — Postgres Outage & Automatic Recovery

1. Stop PostgreSQL:
   ```bash
   docker compose stop postgres
   ```
2. Check health probe:
   ```bash
   curl -i http://localhost:3000/health
   ```
   **Output:**
   ```http
   HTTP/1.1 503 Service Unavailable
   x-correlation-id: 68ad35b3-96f1-4b27-913c-f6e055f8dc4a

   {"success":false,"data":null,"message":"الخدمة غير متوفرة حالياً، يرجى المحاولة لاحقاً","error":{"code":"SERVICE_UNAVAILABLE","message":"الخدمة غير متوفرة حالياً، يرجى المحاولة لاحقاً"},"correlationId":"68ad35b3-96f1-4b27-913c-f6e055f8dc4a","timestamp":"2026-10-23T18:23:37.994Z"}
   ```
   *No internal SQL errors or credentials leaked to the client.*

3. Start PostgreSQL back:
   ```bash
   docker compose start postgres
   ```
4. Query health again without restarting any service:
   ```bash
   curl -i http://localhost:3000/health
   ```
   **Output:**
   ```http
   HTTP/1.1 200 OK
   {"success":true,"data":{"status":"ready", ...},"message":"تمت العملية بنجاح","error":null, ...}
   ```
   *Services automatically reconnect and restore `ready` status.*

---

### Demo 5: Unhappy Path — Redis Outage (Degraded Mode, Not Dead)

1. Stop Redis:
   ```bash
   docker compose stop redis
   ```
2. Query health probe:
   ```bash
   curl -i http://localhost:3000/health
   ```
   **Output:**
   ```http
   HTTP/1.1 200 OK
   x-correlation-id: 5e2976fb-8bf5-476f-a1ec-1886525ee84f

   {
     "success": true,
     "data": {
       "status": "degraded",
       "gateway": {
         "service": "gateway",
         "status": "degraded",
         "dependencies": {
           "database": { "status": "ready" },
           "broker": { "status": "ready" },
           "redis": { "status": "degraded", "message": "Stream isn't writeable and enableOfflineQueue options is false" }
         }
       },
       "services": {
         "catalog": { "status": "degraded", ... },
         "identity": { "status": "degraded", ... },
         ...
       }
     },
     "message": "تمت العملية بنجاح",
     "error": null
   }
   ```
   *Probe remains 200 OK. Cache failure is marked degraded, not dead.*

3. Restart Redis:
   ```bash
   docker compose start redis
   ```
   *Probe seamlessly returns to `ready`.*

---

### Demo 6: Unhappy Path — Graceful Shutdown

1. Stop `identity` service container:
   ```bash
   docker compose stop identity
   ```
2. Inspect container exit status:
   ```bash
   docker compose ps -a identity
   ```
   **Status:** `Exited (0)`
3. Inspect shutdown logs:
   ```json
   {"level":"info","time":"2026-10-23T18:24:22.693Z","service":"identity","context":"GracefulShutdownService","msg":"Received shutdown signal: SIGTERM; completing graceful shutdown"}
   {"level":"warn","time":"2026-10-23T18:24:22.693Z","service":"identity","context":"GracefulShutdownService","msg":"Service has entered graceful shutdown mode; rejecting new traffic"}
   ```
   *In-flight work is drained, new traffic rejected, and connections closed cleanly with exit code 0.*

---

### Demo 7: Happy Path — Authentication Lifecycle and Revocation (e2e)

**Command:**
```bash
npm run test:e2e -- test/e2e/auth.e2e-spec.ts
```

**Output:**
```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  18:36:58
   Duration  28.56s
```

The spec drives the real Compose stack through the gateway only, so it proves
the HTTP edge, gRPC adapter, identity services, outbox relay, gateway
revocation consumer and Mailpit agree with each other:

1. **Sign-up → verify:** `POST /api/v1/auth/sign-up` returns `201`; signing in
   before verification returns `200` with `verificationRequired: true` and no
   tokens; the six-digit code read from Mailpit verifies the account and returns
   the first RS256 pair. The decoded access token carries `sub`, `sid`, `jti`,
   `lvl`, `roles`, `bkbl`, `iss` and `aud`, and contains no email address.
2. **Refresh rotation and grace replay:** the first refresh returns a different
   pair; replaying the consumed token inside the 10-second window returns the
   exact same successor pair rather than treating the client as an attacker.
3. **Sign-out revocation:** sign-out returns `{ "revoked": true }`, the gateway
   consumer writes `auth:revoked:sid:<sessionId>` to Redis, the old access token
   then fails with `401 TOKEN_REVOKED`, and the refresh token fails with
   `401 SESSION_REVOKED`.
4. **Password recovery and BR-09:** an unknown address and a real address both
   get an identical `202` body with `secondsRemaining: 120`. The reset email is
   read from Mailpit, the reset returns `{ "reset": true }`, the account-level
   marker `auth:revoked:account:<accountId>` rejects **both** live sessions, the
   old password gets `401 INVALID_CREDENTIALS`, and the new password signs in.
5. **Staff role isolation:** the seeded operator and conductor sign in with
   `lvl: "traveller"` and exactly one role each; the operator gets `200` on the
   operator route and `403 FORBIDDEN` on the conductor route, and vice versa.
6. **Deny-by-default and prefix rules:** `POST /sign-out` without a bearer token
   is `401 UNAUTHORIZED`, `GET /health/live` is `200`, and
   `GET /api/v1/health/live` is `404`.

The same suite without the file filter runs all five e2e specs:

```text
 Test Files  5 passed (5)
      Tests  25 passed (25)
   Duration  221.18s
```

---

## 4. Verification Check-off Matrix

| Requirement | Implementation Component | Status |
|---|---|---|
| Single command boot (`docker compose up`) | Root `Dockerfile` & `docker-compose.yml` | Verified |
| 7 microservices + 3 shared libs | `apps/` module-first feature modules & `libs/` | Verified |
| TypeORM persistence layer | `@nestjs/typeorm` with `manualInitialization: true` in every service | Verified |
| Joi fail-fast env validation & secret masking | `libs/common/src/config/env.validator.ts` | Verified |
| Bilingual response & error envelope (Arabic fallback) | `HttpExceptionFilter` & `ResponseInterceptor` | Verified |
| Structured JSON logs with PII redaction | `nestjs-pino`, `ClsService`, `pii-redactor.ts` | Verified |
| Correlation ID propagation (HTTP -> gRPC -> AMQP) | `CorrelationMiddleware` & `GrpcCorrelationInterceptor` | Verified |
| gRPC Health aggregation | `libs/contracts/src/proto/health.proto`, `GatewayHealthService` | Verified |
| Identity gRPC contract | `libs/contracts/src/proto/identity.proto` (`train.identity.v1`, `IdentityService`) | Verified |
| Redis degraded mode (§2.3 rule 7) | `RedisHealthService` | Verified |
| Postgres outage auto-recovery | Dynamic connection polling in `HealthService` | Verified |
| Graceful shutdown (SIGTERM / code 0) | `GracefulShutdownService` | Verified |
| RS256 access tokens, `kid` rotation, no `alg` confusion | Identity `IdentityJwtSigner`, gateway `TokenVerifierService` | Verified |
| Deny-by-default gateway authorization | `JwtAuthGuard`, explicit `@Public()` / `@RequireAccess()` metadata | Verified |
| Refresh rotation + 10-second replay grace | `SessionsService`, `SessionIssuer`, sealed successor payload | Verified |
| Prompt, durable session revocation | Outbox event, `SessionRevokedConsumer`, Redis + memory revocation stores | Verified |
| Password recovery without enumeration (BR-09) | `PasswordsService`, account-level revocation marker | Verified |
| Auth lifecycle and staff isolation against the real stack | `test/e2e/auth.e2e-spec.ts` (4 tests) | Verified |
| Staff seed outside migrations | `apps/identity/src/database/seeds/staff-accounts.seed.ts` and the one-shot Compose service | Verified |
| 100% Passing automated tests | Vitest unit & regression suites (471 passed, 1 skipped) | Verified |
