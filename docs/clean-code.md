# Clean code in this repo

Rules with teeth, not aphorisms. Each one is here because breaking it has a
specific cost in *this* codebase.

## Naming

**Files** are kebab-case, suffixed by role, and the suffix is load-bearing — it
tells you which layer the file belongs to without opening it:

```
*.use-case.ts    *.port.ts       *.adapter.ts     *.mapper.ts
*.controller.ts  *.service.ts    *.repository.ts  *.orm-entity.ts
*.dto.ts         *.factory.ts    *.parser.ts      *.module.ts
*.middleware.ts  *.interceptor.ts *.filter.ts     *.enum.ts
*.constants.ts   *.schema.ts     *.config.ts
*.spec.ts        *.e2e-spec.ts
```

The exported class name is the PascalCase of the filename:
`http-exception.filter.ts` → `HttpExceptionFilter`. One primary export per file.

Three suffixes carry architectural meaning and are not interchangeable
([ADR-0007](adr/0007-clean-architecture-feature-modules.md)):

| Suffix | Layer | Means |
|---|---|---|
| `*.port.ts` | `application/ports/` | An interface plus its `Symbol` token. The abstraction a use-case depends on. |
| `*.adapter.ts` / `*.repository.ts` | `infrastructure/` | The implementation. Named for the technology: `TypeOrmAccountRepository`, `GatewayHealthAdapter`. |
| `*.orm-entity.ts` | `infrastructure/persistence/` | The `@Entity` class. **Not** the domain model — `domain/account.ts` has no suffix and no decorators. |

A controller names its transport: `accounts.grpc.controller.ts` →
`AccountsGrpcController`. Two transports onto one use-case means two files, and
the names must say which is which.

A port and its adapter should read as a pair: `AccountRepositoryPort` ↔
`TypeOrmAccountRepository`. The indirection costs a hop when you are reading;
naming is what pays it back.

**Symbols**: `PascalCase` classes and types, `camelCase` functions and
variables, `SCREAMING_SNAKE_CASE` module-level constants, `snake_case` for
database identifiers (tables, columns, indexes, constraints). Index and
constraint names are explicit and prefixed so an error message is greppable:
`uq_account_email_lower`, `idx_outbox_event_unpublished`,
`account_status_check`.

**Say what a thing is, not what it technically holds.** `codeHash` not
`hashedValue`; `nextAttemptAt` not `retryTime`; `publishedAt` nullable rather
than an `isPublished` boolean plus a timestamp that can disagree with it.

Booleans read as assertions: `isConnected`, `hasExpired`, `shouldRetry`. A
function that answers a question is named as a question; a function that does
something is named with a verb.

## Functions

Small enough that the happy path is visible without scrolling. The real rule is
**one level of abstraction per function** — if a function both decides a policy
and issues SQL, split it.

Guard clauses over nesting:

```ts
// good
if (!claim) return { outcome: 'skipped', reason: 'already-handled' };
if (hasExpired(payload.expiresAt, now)) return this.recordExpired(payload);
return this.send(payload);
```

Avoid boolean parameters that select behaviour (`send(payload, true)` tells the
reader nothing). Take an options object with named fields, or two functions.

Return early, return typed results. A function with four possible outcomes
returns a discriminated union (`{ outcome: 'handled' } | { outcome: 'skipped', reason }`),
not `null` plus an out-param plus a thrown exception.

## Errors

**Named classes, not booleans or magic strings.** The distinction between
`InvalidEventPayloadError` and `UnsupportedEventVersionError` is not pedantry —
they produce different `x-death-reason` headers that a replay tool will branch
on. A `return false` cannot carry that.

Put the error type where the decision is made, and make the *class* encode the
policy. `PermanentEventError` exists so the consumer runtime can ask one
question — "is this retryable?" — by checking an instance, instead of pattern
matching on messages.

Never swallow silently. The two legitimate swallows are both deliberate and both
commented at the call site: a connect failure at boot (health reports the truth
instead) and a best-effort cleanup during shutdown. Everything else logs with
context or rethrows.

Never catch to log and rethrow the same error at every layer — one log, at the
layer that knows what it means.

## Comments

The house style is **a comment that explains a non-obvious decision**, and the
standard to match is `test/skeleton/compose.spec.ts:38-43` — six lines
explaining why one healthcheck's exact spelling is load-bearing, which saves the
next person an hour of debugging a container that never reports healthy.

Write a comment when:

- a line looks wrong but is right (`$$POSTGRES_USER`, the double `$` for Compose)
- a non-obvious alternative was rejected (and say why — "`migrationsRun: true` does not work here because `manualInitialization` prevents it")
- an invariant is enforced somewhere else ("the lock is held across the publish — that is why two relays never double-publish")
- a number was chosen rather than guessed (cite the budget it came from)

Do **not** write a comment that restates the code, a changelog, a `TODO` without
an owner, or commented-out code. Delete dead code; git remembers it.

Doc comments (`/** */`) on exported library functions and on any type crossing a
service boundary. A field in an event payload gets a line saying who needs it
and why it is safe to send — that is the document a reviewer reads to check the
"the code crosses the wire once" rule.

## Data and persistence

**Always set `name:` explicitly on every TypeORM column.** TypeORM's default
naming strategy is camelCase; the migrations here are hand-written `snake_case`.
Rely on the default and the entity silently addresses a column that does not
exist — which surfaces at runtime, not at compile time.

```ts
@Column({ type: 'timestamptz', name: 'published_at', nullable: true })
publishedAt: Date | null;
```

Put the invariant in the database when the database can hold it. A `CHECK`
constraint on a status column, a `UNIQUE` index on `lower(email)`, a `PRIMARY
KEY` doing idempotency duty — these keep holding when the application has a bug,
and a `SELECT`-then-`INSERT` in application code does not.

Prefer a nullable timestamp (`published_at`, `consumed_at`, `handled_at`) over a
boolean plus a separate time column: one column cannot contradict itself.

Index for the query you actually run, and make it partial when the predicate is
stable. `WHERE published_at IS NULL` keeps the outbox relay's index the size of
the backlog rather than the size of history.

Migrations are hand-written, forward-only in spirit, and `down()` must reverse
`up()` in the opposite order (child tables before parents).

## Secrets and PII

- A verification code is **email-only**. It is never persisted in plaintext, never written to a `notification` table, and never logged.
- Store a hash plus a per-row salt, and compare with `timingSafeEqual`. Never a bare `sha256` of a 6-digit code — that is brute-forceable in under a second.
- pino redaction catches `password`, `token`, `code`, `verificationCode` **as object keys only**. A value interpolated into a message string is not redacted by anything:

  ```ts
  logger.info({ accountId, codeId }, 'verification code issued');  // safe
  logger.info(`issued ${code} to ${email}`);                        // leaks
  ```

- The same applies to anything derived from an error: a `last_error` column, an `x-death-error` header, an SMTP failure message. Store the error's `message`, never the payload it failed on.
- Email addresses are masked with `maskEmail()` before storage or logging where the full address is not needed.

## Dependencies

Reach for a Node builtin first. `node:crypto` covers hashing (`scryptSync`),
random codes (`randomInt` — uniform, unlike `% n`), and ids (`randomUUID`).

Before adding a package, answer: does the `node:*-alpine` runtime image build
it? `bcrypt` and `argon2` are native addons and need a toolchain the image does
not have. Does it duplicate something already here? `joi`, `class-validator`,
`nestjs-cls` and `amqplib` are already in and already have a house pattern.

A new dependency gets a line in an ADR or the PR body saying what it replaced.

## Concurrency

`setTimeout` that reschedules itself, never `setInterval` — `setInterval`
overlaps ticks, and two overlapping polls in one process will fight over the
same rows. `.unref()` the timer so a pending tick cannot hold the process open.

`oxlint` enforces `no-floating-promises`. For a loop nobody awaits at the call
site, hold it on a field:

```ts
private loop: Promise<void> | null = null;

onApplicationBootstrap(): void { this.loop = this.run(); }

async beforeApplicationShutdown(): Promise<void> {
  this.stopping = true;
  if (this.timer) clearTimeout(this.timer);
  await this.loop;        // the drain comes free
}
```

Drain in `beforeApplicationShutdown`, not `onApplicationShutdown`: the latter
runs after `dispose()` and, for an AMQP loop, after the channel has already
closed.

Do not disable the rule. The pattern that satisfies it is the pattern that
drains correctly on shutdown — that is not a coincidence.

## Tests

A test name states the behaviour and cites its requirement:

```ts
describe('Envelope & i18n Translation System (BR-56, BR-57, D14, §2.4)', () => {
  it('falls back to Arabic for an unsupported language', () => {
```

Assert the absence of things, not only the presence. "The use-case injects no
publisher" and "no file under `apps/identity` imports `nodemailer`" are how
architectural decisions stay true after the person who made them has moved on.

One behaviour per test. A test that needs three `expect` blocks about three
different things is three tests, and when it fails you will want to know which.
