# ADR-0005 — The envelope carries the version; an unknown version dead-letters

**Status:** Accepted · **Date:** 2026-10-24 · **Relates to:** §10.C

## Context

Producers do not know their consumers — that is the point of the backbone.
`identity` publishes "a verification code was issued" and has no idea who reads
it. But that independence is also the hazard: `identity` can rename a payload
field, its own tests pass, and a consumer breaks in production.

Worse, during any rollout the two sides are *simultaneously* at different
versions. A consumer must be able to receive a message it cannot read and do
something defensible with it.

Requirements from the story:

- Every event carries an ID, a type, a version, the time it occurred, the correlation ID and the producer, plus its payload (§10.C).
- The schema lives in `libs/contracts`.
- **A contract test fails the build when a producer changes the schema in a way a consumer cannot read.**
- An event with a version the consumer does not know, or a missing required field, goes to the dead-letter queue at once rather than being retried forever.

## Decision

### The envelope

```ts
interface EventEnvelope<TType extends string, TPayload> {
  id: string;             // globally unique -> the consumer's idempotency key
  type: TType;            // 'identity.verification-code.issued'
  version: number;        // integer, bumped only for a breaking payload change
  occurredAt: string;     // ISO-8601 UTC, stamped inside the producer's transaction
  correlationId: string;  // ties the async hop back to the originating request
  producer: string;       // 'identity'
  payload: TPayload;
}
```

Lives in `libs/contracts/src/events/`. Contracts hold **shapes only** — no
logic, no DI, no I/O — so a producer and a consumer share a type without
sharing a dependency.

`id` is minted once, in the producer's transaction, and is the outbox row's
primary key. The same identity flows to the consumer's `processed_event` primary
key, which is what makes deduplication work end to end.

**`EventLanguage` is duplicated in `contracts` rather than imported from
`@app/common`.** `libs/common/src/envelope/catalogue.ts:1` already imports
`@app/contracts`, so the reverse edge would be a dependency cycle. A type test
asserts the two unions stay mutually assignable, so they cannot drift silently.

### Version lives in the envelope, not the routing key

An unreadable version is a **dead-letter decision, not a routing decision**. The
consumer has to *see* the message to report why it could not read it; routing it
away by key would make the failure invisible. A genuinely breaking change takes a
new routing key suffix (`identity.verification-code.issued.v2`) so old and new
consumers coexist during a rollout — but that is a deliberate, separate act, not
the default.

### Two distinct error classes, both permanent

```ts
class InvalidEventPayloadError extends PermanentEventError     // reason: 'invalid-payload'
class UnsupportedEventVersionError extends PermanentEventError // reason: 'unsupported-version'
```

Both dead-letter immediately with no retry, because neither will ever become
valid. They are **separate classes** because they carry different
`x-death-reason` values and they call for opposite responses:

- `invalid-payload` — a producer bug. These are unreplayable; fix the producer.
- `unsupported-version` — a deployment ordering problem. Deploy the consumer that understands the version, **then** replay.

The Sprint-5 replay tool branches on exactly that distinction, which is why the
difference is encoded in the type system now rather than discovered later.

### What is a contract violation, and what is not

| Input | Outcome | Why |
|---|---|---|
| Missing required envelope or payload field | `InvalidEventPayloadError` → DLQ | Unreadable. |
| `version` the consumer does not know | `UnsupportedEventVersionError` → DLQ | Unreadable *by this build*. |
| `type` the consumer did not subscribe to | `InvalidEventPayloadError` → DLQ | A routing or binding mistake. |
| `language: 'fr'` — an unknown but non-essential value | **Coerce to `'ar'`** and handle normally | An unsupported language must not dead-letter a real sign-up. BR-56 already defines Arabic as the fallback. |
| `expiresAt` in the past | **Parses fine**; the handler skips the send | Expiry is a handling decision, not a contract violation. Failing the parse would send recoverable traffic to the DLQ. |

That last pair is the judgement in this ADR: strictness is for things that make
the message *unreadable*, not for things that make it *inconvenient*. Being
strict about a value you have a documented fallback for throws away real user
sign-ups.

### The contract test

Three artifacts, in `test/unit/event-contract.spec.ts`:

1. A **producer-owned builder** — deterministic given a fixed clock and id.
2. A **consumer-owned parser** — *the same function the running handler uses*. A test-only schema would drift from reality, and the one in production would be the untested one.
3. A committed **golden sample** (`test/fixtures/events/verification-code-issued.v1.json`), generated from the builder, never hand-typed.

The assertion that does the work: for each required envelope key and each
required payload key, delete it and confirm the parser throws. **A producer that
stops emitting a field the consumer needs fails. A consumer that starts
requiring a field the producer does not emit fails.** Neither side can move
alone. And because the builder must deep-equal the golden sample, any rename
turns red and going green requires editing a committed file — making the schema
change a visible, reviewable diff rather than an accident.

## Consequences

**Bought:** a schema change cannot reach production unnoticed; a consumer can
always explain why it rejected a message; version skew during a rollout is a
visible DLQ entry with a known remedy rather than a crash.

**Cost:**

- The golden sample must be regenerated on every intentional schema change — deliberate friction, and the point.
- `version` is an integer, not semver. Additive, backward-compatible changes do **not** bump it; they just work, because the parser checks required fields rather than rejecting unknown ones. Only a breaking change bumps.
- A duplicated `EventLanguage` union, kept honest by a type test.

**Made impossible:** a silent breaking change, and a retry loop on a message
that can never be parsed.

## Alternatives considered

**Version in the routing key only** (`...issued.v1`). Rejected as the primary
mechanism: a consumer bound to `v1` never sees a `v2` message, so a producer
rollout silently drops events for consumers that have not caught up — the
failure is invisible until someone notices missing emails. Kept as the escape
hatch for a *deliberate* breaking change, where coexistence is the goal.

**JSON Schema / Avro with a schema registry.** Rejected for now: real
machine-checkable compatibility, but it adds a registry container (which
`compose.spec.ts` forbids) and a build step, and at one producer and one
consumer the consumer-driven test gives the same guarantee at a fraction of the
cost. Revisit when producers or consumers reach double digits.

**`class-validator` DTOs for the parser.** Rejected: it is already a
dependency and would be idiomatic, but a decorator-driven DTO cannot cleanly
produce the two *distinct* error classes the DLQ reasons depend on, and a plain
function is what makes the parser's purity (no I/O, no DI) assertable.

**No versioning; just add fields and never remove.** Rejected: it works until
the first field whose *meaning* changes, at which point there is no mechanism to
notice. The version field costs nothing when unused.

**Trusting the producer's own tests.** Rejected — that is the status quo this
ADR replaces. A producer's tests cannot fail for a consumer's requirement they
have never heard of.
