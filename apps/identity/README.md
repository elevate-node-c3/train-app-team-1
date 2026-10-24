# Identity service

Identity owns traveller accounts. It currently provides:

- **Sign-in**, with a lockout after too many failed attempts.
- **Password recovery**: request a reset code by email, then set a new
  password with that code.

It listens on HTTP port 3000 and serves gRPC health checks on 50051. The
gateway does not proxy the routes below yet, so for now they are reachable
only inside the Compose network at `http://identity:3000`.

> **Identity does not start yet.** It needs three services that teammates are
> building. See [Integrations still needed](#integrations-still-needed).

## Routes

Every response uses the platform envelope
(`success`, `data`, `message`, `error`, `correlationId`, `timestamp`).
Messages are in Arabic by default and in English with `Accept-Language: en`.

| Route | Body | Success |
| --- | --- | --- |
| `POST /auth/sign-in` | `email`, `password` | 200, `data` is the session |
| `POST /auth/password/forgot` | `email` | 202, `data` is `null` |
| `POST /auth/password/reset` | `email`, `code`, `newPassword`, `confirmPassword` | 200, `data` is `null` |

Sign-in also reads the optional `x-device-id` and `user-agent` headers and the
client IP, and passes them on with the session request.

### Validation (400 `VALIDATION_ERROR`)

| Field | Rule |
| --- | --- |
| `email` | A valid email. Case does not matter. |
| `password` (sign-in) | A non-empty string. |
| `code` | Exactly 6 digits. |
| `newPassword` | The password policy (BR-02): at least 8 characters, with an uppercase letter, a lowercase letter, a digit and a symbol. At most 72 bytes, bcrypt's limit. |
| `confirmPassword` | A string. It must equal `newPassword`; a mismatch returns `PASSWORD_MISMATCH`. |

The policy is in `src/domain/password/password-policy.ts`. It is applied with
class-validator's built-in `@IsStrongPassword`, so sign-up can reuse it.

### Errors

| Code | Status | When |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | Wrong password, unknown email, or wrong password on an unverified account. All three get exactly the same response. |
| `ACCOUNT_LOCKED` | 423 | The email is locked after 10 failed sign-ins. `error.meta.retryAfterSeconds` and the `Retry-After` header give the time left. |
| `VERIFICATION_REQUIRED` | 403 | Correct password, but the account is not verified. `error.meta.verificationCodeSent` says whether a code was sent; if not, `resendAfterSeconds` says when one can be. |
| `PASSWORD_MISMATCH` | 400 | `confirmPassword` does not equal `newPassword`. |
| `INVALID_RESET_CODE` | 400 | Unknown email, or a code that is wrong, expired, already used or out of attempts. |
| `PASSWORD_REUSED` | 400 | The new password is the current one. |
| `SERVICE_UNAVAILABLE` | 503 | Redis is down. Sign-in refuses rather than run without the lockout. |

Example of a locked account:

```json
{
  "success": false,
  "data": null,
  "message": "The account is temporarily locked after too many failed sign-in attempts, please try again later",
  "error": {
    "code": "ACCOUNT_LOCKED",
    "message": "The account is temporarily locked after too many failed sign-in attempts, please try again later",
    "meta": { "retryAfterSeconds": 898 }
  },
  "correlationId": "…",
  "timestamp": "…"
}
```

## How it works

### Sign-in

1. Lowercase the email.
2. Reserve an attempt in Redis. If the email is locked, return
   `ACCOUNT_LOCKED`. The refused attempt is not counted and the lock is not
   extended.
3. Check the password with bcrypt. An unknown email is checked against a
   dummy hash, so it takes as long as a wrong password.
4. On a wrong password or an unknown email, return `INVALID_CREDENTIALS`. The
   10th failure locks the email for 15 minutes and returns `ACCOUNT_LOCKED`.
5. On a correct password, reset the failure counter. Then:
   - **Unverified account:** ask for a verification code and return
     `VERIFICATION_REQUIRED`.
   - **Verified account:** create the session, publish
     `traveller.signed_in`, and return the session.

### Lockout

| Setting | Value |
| --- | --- |
| Failures before the lock | 10 |
| Failure counter window | 15 minutes after the last failure |
| Lock duration | 15 minutes, never extended |

A Lua script reserves each attempt *before* the slow password check. It
refuses if the email is locked, and otherwise counts the attempt. However many
requests arrive in parallel, even across several instances, at most 10
password checks run. The lockout applies to unknown emails too, so locking
reveals nothing about which emails are registered.

Redis keys hash the email, so no address appears in a key name:

| Key | Purpose |
| --- | --- |
| `identity:signin:fail:{emailHash}` | Failed-attempt counter |
| `identity:signin:lock:{emailHash}` | Lock |

### Forgot password

1. Look up the account by email.
2. **Only if it exists**, store a new code and publish
   `password_reset_code.issued`. A new code replaces the previous one.
3. Wait until at least 500 ms have passed, then return 202.

The response and its timing are the same for every email, so the endpoint
does not reveal which emails are registered. If storing or sending the code
fails, the error is logged and the response does not change.

### Reset password

The steps run in this order. A failing step never affects the steps after it.

1. The DTO checks the new password's strength; then the passwords must
   match. Neither touches the code.
2. Find the account's usable code and compare it in constant time.
3. A wrong code uses up one of its 5 attempts, atomically.
4. If the new password is the current one, return `PASSWORD_REUSED`. The code
   stays usable.
5. In one Postgres transaction, use up the code and save the new password.
   This marks the email verified if it wasn't, and sets `passwordChangedAt`.
   The code is used up only if it is still unused, unexpired and under 5
   attempts, so of two parallel requests exactly one succeeds.
6. After the commit:
   - Clear the lockout.
   - Revoke all of the account's sessions.
   - Publish `password.reset`.

   None of these can fail the reset; errors are logged. No session is created,
   so the user signs in again with the new password.

### Reset codes

| Setting | Value |
| --- | --- |
| Format | 6 digits from the crypto RNG |
| Lifetime | 10 minutes |
| Wrong attempts allowed | 5 |
| Stored as | `HMAC(IDENTITY_CODE_HMAC_SECRET, purpose|accountId|code)` |

Including the purpose in the HMAC means a verification code can never be used
as a reset code. The raw code is never stored, and it must never be logged:
the log redactor only masks object keys named like `code`.

### Passwords

Passwords are hashed with `bcryptjs` at cost 10, and checked with
`bcrypt.compare`.

## Events

Events are published to the durable topic exchange `train.domain-events`, with
the event type as the routing key. Each one is wrapped in the standard
envelope (`eventId`, `type`, `version`, `occurredAt`, `correlationId`,
`payload`).

| Type | Published when | Payload |
| --- | --- | --- |
| `traveller.signed_in` | A session is created | `accountId`, `sessionId` |
| `account.locked` | A real account becomes locked | `accountId`, `email` |
| `password_reset_code.issued` | A reset code is stored | `accountId`, `email`, `code`, `expiresAt`, `language` |
| `password.reset` | A reset is committed | `accountId`, `email`, `passwordChangedAt` |

Each event reports something that has already happened, so a failed publish
is logged and does not fail the request. `password_reset_code.issued` carries
the raw code, for the notification service to email.

## Database

TypeORM creates the tables from the entities (`synchronize: true`); there are
no migrations.

**`accounts`**

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `email` | Lowercased, unique |
| `password_hash` | bcrypt |
| `verified_at` | Null until the email is verified |
| `password_changed_at` | |
| `created_at`, `updated_at` | |

**`one_time_codes`**

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `account_id` | |
| `purpose` | `password_reset` or `email_verification`. Unique together with `account_id`. |
| `code_hash` | The HMAC, never the code |
| `attempts` | Wrong guesses so far |
| `expires_at` | |
| `consumed_at` | Null until used |

## Configuration

| Variable | Notes |
| --- | --- |
| `PORT` | HTTP port (3000 in Compose) |
| `GRPC_PORT` | gRPC health port, default 50051 |
| `DATABASE_URL` | Identity's own Postgres database |
| `REDIS_URL` | Used for the lockout |
| `RABBITMQ_URL` | Used for events |
| `IDENTITY_CODE_HMAC_SECRET` | At least 32 characters. Treated as a secret. A dev value is in `.env.example` and `docker-compose.yml`. |

Identity refuses to start if any variable is missing or invalid.

## Integrations still needed

Identity calls three services it does not implement. Nothing provides them
yet, so **identity does not start** until they are registered.

| Token | Owner | Used for |
| --- | --- | --- |
| `SESSION_SERVICE` | Member 2 | `createSession` after a successful sign-in |
| `ACCOUNT_REVOCATION_SERVICE` | Member 2 | `revokeAll` after a password reset |
| `VERIFICATION_CODE_ISSUER` | AUTH-2 | `issue` when an unverified account signs in |

The interfaces are in `@app/contracts` (`auth/`) and in
`src/domain/ports/verification-code-issuer.ts`. To connect them, import the
module that provides them into `identity.module.ts`, or bind them there:

```ts
providers: [
  { provide: SESSION_SERVICE, useClass: SessionServiceImpl },
  { provide: ACCOUNT_REVOCATION_SERVICE, useClass: AccountRevocationImpl },
  { provide: VERIFICATION_CODE_ISSUER, useClass: VerificationCodeIssuerImpl },
],
```

## Current limitations

- **No resend limit on forgot-password.** `TOO_MANY_REQUESTS` exists but
  nothing returns it yet.
- **No sign-up yet.** Accounts have to be inserted by hand. Sign-up should
  lowercase the email, hash with `bcrypt.hash(password, BCRYPT_SALT_ROUNDS)`,
  and validate with `PASSWORD_POLICY`.
- **Two test files fail until the integrations above are bound:**
  `test/skeleton/apps.spec.ts` (identity's module can't resolve the three
  tokens) and `test/unit/identity-auth-foundations.spec.ts` (it imports
  removed files).

## Layout

```text
src/
  main.ts                              boot: env check, HTTP and gRPC
  identity.module.ts                   wiring
  domain/
    sign-in.service.ts                 sign-in and lockout flow
    password-recovery.service.ts       forgot and reset flows
    one-time-code.ts                   code generation and HMAC hashing
    identity-events.ts                 event publishing
    password/password-policy.ts        BR-02 rules and the bcrypt cost
    ports/verification-code-issuer.ts  AUTH-2 interface
  persistence/
    account.repository.ts
    one-time-code.repository.ts        includes the reset transaction
    sign-in-attempt.store.ts           Redis lockout (Lua)
    identity-redis.service.ts          Redis client that fails closed
    entities/                          accounts, one_time_codes
  transport/
    auth.controller.ts                 the three /auth routes
    dto/                               request validation
```
