# Design patterns in this platform

Each entry: the problem, the mechanism, where it lives, and how it fails if you
get it wrong. These are the patterns the messaging backbone is built from —
every event in the catalogue rides the same ones.

---

## Transactional Outbox

**Problem — the dual write.** A service must change its own state *and* tell
other services. Two separate writes to two systems cannot be made atomic:

```ts
await repo.save(account);          // committed
await rabbit.publish(event);       // process dies here -> the event never existed
```

Reverse the order and you get the opposite bug: an event announcing a change
that was rolled back. There is no ordering that fixes it, which is the point —
it needs a different shape.

**Mechanism.** The event is written as a row in the producer's **own database,
in the same transaction as the business change**. One commit, so the two cannot
disagree. A separate process publishes the row afterwards.

```ts
await this.unitOfWork.withTransaction(async (ctx) => {
  await this.accounts.save(ctx, account);
  await this.codes.save(ctx, verificationCode);
  await this.outbox.append(ctx, envelope);   // same ctx, same transaction
});
// the response goes back here. nothing has been published yet, and that is fine.
```

**Lives in**
`apps/identity/src/modules/accounts/application/use-cases/sign-up.use-case.ts`,
with the `outbox_event` table and its adapter under
`apps/identity/src/modules/accounts/infrastructure/persistence/`. The
`TransactionContext` is opaque to the use-case — see
[Ports and Adapters](#ports-and-adapters) below.

**How it fails.** A repository that opens its own transaction instead of
joining the caller's: you are back to a dual write that merely *looks*
transactional. This is why every port method takes the `TransactionContext` as
a parameter and the adapter unwraps it, and why a test asserts no repository
accepts a `DataSource`. Equally: injecting a publisher into the use-case at
all. If it isn't there, it cannot be called in the wrong place.

**Trade-off.** Publishing is asynchronous and at-least-once, so every consumer
must be idempotent. You trade exactly-once delivery (which does not exist) for
never losing a message.

See [ADR-0001](adr/0001-transactional-outbox.md).

---

## Polling Publisher (the relay)

**Problem.** Rows are sitting in `outbox_event`. Something must publish them,
exactly once per row if possible, and more than one instance of the service may
be running.

**Mechanism.** A background loop claims a batch with `FOR UPDATE SKIP LOCKED`,
publishes each row, waits for the **broker's confirm**, and only then sets
`published_at`. All inside the claiming transaction, so the row lock is still
held when the row is marked.

```sql
SELECT ... FROM outbox_event
 WHERE published_at IS NULL AND next_attempt_at <= now()
 ORDER BY occurred_at LIMIT 20
   FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` is the whole multi-instance story: a second relay's `SELECT`
steps over the locked rows instead of blocking on them, so two relays make
progress on disjoint batches without coordination, a leader election, or a
distributed lock.

**Lives in**
`apps/identity/src/modules/accounts/infrastructure/persistence/outbox-relay.service.ts`.
The relay is infrastructure, not a use-case: it implements a delivery
mechanism and talks to both Postgres and the broker directly.

**How it fails.**

- Marking `published_at` *before* the confirm resolves — the broker nacks, the row is marked, the event is lost. Confirm first, always.
- Committing the claim transaction before publishing — the lock is gone and a sibling relay republishes the same row. Duplicates are survivable, but it defeats the point of the lock.
- `setInterval` instead of a self-rescheduling `setTimeout` — ticks overlap and one process fights itself.
- Letting a tick's rejection escape. The loop must catch, log, and live to tick again; a relay that dies on the first Postgres blip loses the "down is not broken" property.

**Trade-off.** Polling costs a query per interval and adds up to one interval of
latency. At 500ms that is a small slice of a 30-second budget, and it buys
operational simplicity over CDC (Debezium) or `LISTEN/NOTIFY`, neither of which
survives a consumer restart as plainly.

See [ADR-0002](adr/0002-relay-claims-with-skip-locked.md).

---

## Message Envelope + versioning

**Problem.** A consumer receiving raw payload JSON cannot tell what it is
reading, cannot deduplicate it, cannot trace it, and cannot survive the producer
changing shape.

**Mechanism.** Every event is wrapped in the same envelope, with the payload as
one field:

```ts
interface EventEnvelope<TType extends string, TPayload> {
  id: string;             // globally unique -> the consumer's idempotency key
  type: TType;            // 'identity.verification-code.issued'
  version: number;        // bumped only for a breaking payload change
  occurredAt: string;     // ISO-8601, stamped inside the producer's transaction
  correlationId: string;  // ties the async hop back to the originating request
  producer: string;       // 'identity'
  payload: TPayload;
}
```

**Lives in** `libs/contracts/src/events/`. Contracts hold shapes only — no
logic, no DI, no I/O — so a producer and a consumer can share a type without
sharing a dependency.

**Version is not in the routing key.** An unreadable version is a
*dead-letter decision*, not a routing decision: the consumer must see the
message to report why it couldn't read it. A genuinely breaking change takes a
new routing key suffix (`...issued.v2`) so old and new consumers coexist during
a rollout.

**How it fails.** `id` reused or derived from content, so two genuinely distinct
events collide and one is silently deduplicated away. Mint it once, in the
producer's transaction, and let it be the outbox row's primary key — then the
same identity flows all the way to the consumer's `processed_event` table.

See [ADR-0005](adr/0005-event-envelope-versioning.md).

---

## Consumer-Driven Contract test

**Problem.** The producer owns the schema and cannot see its consumers. It
renames a field, its own tests pass, and a consumer breaks in production.

**Mechanism.** Three artifacts and one test that holds them together:

1. A **producer-owned builder** (`apps/identity/src/modules/accounts/domain/events/verification-code-issued.factory.ts`), deterministic given a fixed clock and id.
2. A **consumer-owned parser** (`apps/notification/src/modules/verification-emails/application/verification-code-issued.parser.ts`) — *the same function the running handler uses*, which is what makes the test honest. A test-only schema would drift from reality.
3. A committed **golden sample** (`test/fixtures/events/verification-code-issued.v1.json`).

The test asserts the builder's output deep-equals the golden sample, the
consumer's parser accepts the builder's live output, and — the directional
assertion that actually matters — deleting any required field makes the parser
throw. A producer that stops emitting a field the consumer needs fails. A
consumer that starts requiring a field the producer does not emit fails.
**Neither side can move alone.**

**Lives in** `test/unit/event-contract.spec.ts`.

**How it fails.** Writing the golden sample by hand from the spec rather than
generating it from the builder — then it tests your typing, not the code. And
making the test's validator separate from the handler's: two validators drift,
and the one in production is the one you didn't test.

---

## Idempotent Consumer

**Problem.** At-least-once delivery means duplicates are *normal*, not
exceptional: a relay republish, a broker redelivery after a crash, a retry. For
a verification email, a duplicate is a second email (BR-54 says one effect).

**Mechanism.** The consumer records handled event ids **in its own database**
and the record is a `PRIMARY KEY`, so the guard is a constraint rather than a
`SELECT`-then-`INSERT`:

```sql
INSERT INTO processed_event (event_id, status, ...) VALUES ($1, 'processing', ...)
ON CONFLICT (event_id) DO UPDATE
   SET status = 'processing', attempt_count = processed_event.attempt_count + 1
 WHERE processed_event.status = 'failed'
    OR (processed_event.status = 'processing'
        AND ($5::boolean OR processed_event.claimed_at < now() - lease))
RETURNING attempt_count;
```

One round trip. A row comes back ⇒ you own the claim ⇒ handle it. No row ⇒
someone else already did, or is doing it ⇒ ack and send nothing.

**Why `$5` (`msg.fields.redelivered`) bypasses the lease.** A redelivery only
happens because a consumer's channel closed unacked — it crashed — so nobody
live holds that claim, and waiting out the lease would make the redelivery
*skip* and lose the email. Fresh duplicates are unaffected because they are not
redeliveries. This single predicate is what lets "crash mid-handling ⇒
redelivery works" and "two instances, same duplicate, same instant ⇒ one email"
both be true.

**Lives in** `apps/notification/src/modules/verification-emails/`:
`infrastructure/persistence/typeorm-processed-event.repository.ts` behind
`application/ports/processed-event.repository.port.ts`, driven by
`application/use-cases/handle-verification-code-issued.use-case.ts`.

**How it fails.** `SELECT` then `INSERT` — two instances both read "not
handled" and both send. Or: forgetting to **release the claim on a transient
failure**. The lease is a crash net measured in minutes; the retry arrives in a
second, finds a fresh lease, refuses the claim, and silently drops the email on
the first SMTP blip. The normal retry path must explicitly set `status='failed'`
before rethrowing.

---

## Acknowledge-after, not before

**Problem.** Ack on receipt and a crash mid-handling loses the message. Ack
before the side effect and a crash loses the side effect.

**Mechanism.** `noAck: false`, and `channel.ack(msg)` runs only after handling
*finishes*. An unacked message whose channel closes is redelivered by the
broker. `prefetch` bounds how many a single instance holds at once.

**Consequence you must choose.** Between "Mailpit accepted the email" and
"recorded as handled" there is a window. A crash there yields a **duplicate
email**, because the row stays `processing` and the redelivery takes it over. We
chose that over the inverse (record first, then send), which turns every crash
into a silently lost sign-up. For a verification code, missing is far worse than
duplicate — see [ADR-0003](adr/0003-duplicate-email-over-missing-email.md).

**Lives in** `libs/messaging/src/event-consumer.service.ts`.

**How it fails.** Draining in `onModuleDestroy` instead of
`onApplicationShutdown`: Nest fires `onModuleDestroy` later, the channel is
already closed, every in-flight ack fails silently, and a clean deploy becomes a
batch of duplicate emails.

---

## Retry with backoff, then Dead Letter Channel

**Problem.** SMTP is briefly down — retrying is right. The payload is
unparseable — retrying is forever wrong. And a message that keeps failing must
not block the messages behind it.

**Mechanism — classify first, then route.**

- **Permanent** failure (invalid payload, unknown version): straight to the dead-letter exchange with an `x-death-reason`, then **ack**. It will never become valid; the ack is what stops it blocking the queue.
- **Transient** failure: republish to the next per-attempt **TTL retry queue**, then **ack**. The retry queue has no consumer — the message sits there until `x-message-ttl` expires and the broker dead-letters it back onto the main queue, with the attempt count carried in a header. Three delays: 1s, 3s, 9s.
- **Exhausted**: to the DLQ with `x-death-reason: retries-exhausted`.

Both paths **ack the original**, so the queue head is never held by a failing
message. That, plus `prefetch`, is the whole poison-message story — nothing
queues behind a bad message.

The retry queues dead-letter via a `direct` *requeue* exchange keyed on the
**queue name**, not back to the topic exchange on the original routing key — a
topic redelivery would fan one consumer's retry out to every other consumer
later bound to that key.

**Lives in** `libs/messaging/src/amqp-topology.ts` (the declarations) and
`event-consumer.service.ts` (the classification).

**How it fails.** `nack(requeue: true)` as the retry mechanism: the message
returns to the head of the queue instantly, with no delay and no attempt count,
and spins at full speed forever — the classic poison-message livelock.
`nack(requeue: false)` is only correct when you want the broker's own DLX path
and need no reason header.

**Delays are not free-form.** They are chosen against the BR-03 budget and
`test/unit/amqp-topology.spec.ts` asserts the arithmetic, so raising one past
the budget is a red build:

```
500 (poll) + 4 × 3000 (attempt cap) + (1000 + 3000 + 9000) = 25 500 ms < 30 000
```

See [ADR-0004](adr/0004-retry-topology-ttl-queues.md).

---

## Publish/Subscribe with a queue per consumer

**Problem.** Two services care about the same event. Bind them to one queue and
they *compete* — each message goes to one of them, so each service sees half the
events.

**Mechanism.** A topic exchange, and **every consumer declares its own queue**
bound to the routing keys it cares about. Each queue gets its own copy. Adding a
consumer is adding a queue; the producer does not change, does not redeploy, and
does not know.

Queues, exchanges and DLQs are declared **in code, by their owner**, asserted on
every boot (AMQP asserts are idempotent). Nothing is created by hand in the
management console, so a rebuilt broker is identical and the topology is
reviewable in a diff.

**`mandatory` is deliberately not set on publish.** Publishing an event that no
queue is bound to must succeed and be dropped — otherwise "add a consumer
later" would require the producer to tolerate unroutable returns. The
consequence to know: a consumer only receives events published *after* its queue
first existed, which is why the demo uses `docker compose stop` (keeps the
durable queue) and not `rm`.

**Lives in** `libs/messaging/src/amqp-topology.ts`.

---

## Producers do not know their consumers

Not a mechanism — a constraint, enforced by tests.

`identity` publishes "a verification code was issued" and stops. It has no
notification client, no email template, no SMTP configuration, and no knowledge
that email exists. `test/unit/architecture-boundaries.spec.ts` asserts no file
under `apps/identity` imports `nodemailer`, `EventConsumerService`, or reads
`SMTP_*`; the sign-up use-case test asserts its constructor injects no
publisher.

The payoff is testable: adding a second consumer of this event touches zero
lines in `identity`.

---

## Ports and Adapters

**Problem.** A use-case that imports a TypeORM repository cannot be read
without reading SQL, cannot be tested without a database, and quietly makes the
business rule depend on the storage engine. The same goes for SMTP and the
broker.

**Mechanism.** The *application* layer declares what it needs as an interface
plus a DI token; the *infrastructure* layer provides the implementation; the
feature module binds them.

```ts
// application/ports/account.repository.port.ts
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
export interface AccountRepositoryPort {
  save(ctx: TransactionContext, account: Account): Promise<void>;
  findByEmail(email: Email): Promise<Account | null>;
}

// accounts.module.ts
providers: [
  SignUpUseCase,
  { provide: ACCOUNT_REPOSITORY, useClass: TypeOrmAccountRepository },
]
```

The dependency now points *inward*: infrastructure depends on an interface the
application owns, instead of the application depending on infrastructure. That
inversion is the whole of clean architecture; everything else is folders.

**Lives in** every feature's `application/ports/`. The worked example in the
repo today is
`apps/gateway/src/modules/health-aggregation/`, where `ServiceHealthPort` keeps
the gRPC fan-out out of the use-case.

**The payoff is testing, not swappability.** You will probably never write a
second `AccountRepositoryPort`. What you get immediately is a use-case test
with a ten-line fake and no container:

```ts
const accounts: AccountRepositoryPort = {
  save: async () => {},
  findByEmail: async () => null,
};
```

**How it fails.** Porting everything. A pure function (`hashVerificationCode`)
behind an interface is pure ceremony, and a `ClockPort` is usually worse than
passing `now` in the command. **Ports are for crossings** — things that leave
the process. Judge by "would I need to stub this to test the rule?", not by
"is it a dependency?".

### Transactions across several ports

A use-case must put several writes in one transaction without importing
TypeORM. `UnitOfWorkPort` hands it an **opaque** `TransactionContext` that only
an infrastructure adapter can unwrap:

```ts
await this.unitOfWork.withTransaction(async (ctx) => {
  await this.accounts.save(ctx, account);
  await this.outbox.append(ctx, event);   // same ctx => same transaction
});
```

**Lives in**
[libs/common/src/persistence/unit-of-work.port.ts](../libs/common/src/persistence/unit-of-work.port.ts)
(which imports nothing, so the application layer can use it) and
[typeorm-unit-of-work.ts](../libs/common/src/persistence/typeorm-unit-of-work.ts)
(which holds the `EntityManager`).

This is what keeps the Transactional Outbox guarantee structural after the
layering: a use-case **cannot** run a query outside the transaction it was
given, because it has no way to get at a connection.

---

## Repository

**Problem.** SQL spread through use-cases makes the business rule unreadable and
the data access untestable.

**Mechanism.** One port per aggregate, one adapter implementing it in
`infrastructure/persistence/`. Methods are named for the business question
(`findLiveCodeFor`, not `selectWhereExpiresAtGt`) and take and return **domain**
objects, not ORM entities — the mapper converts at the boundary.

**The transaction rule:** a repository method that must join a caller's
transaction takes the `TransactionContext` as a **parameter** and never opens
its own. Only the use-case decides transaction boundaries. That is what makes
the outbox write atomic with the business change, and it is the single most
important consequence of this pattern here.

**How it fails.** Returning the ORM entity. The decorator-carrying class then
leaks through the port into the application layer, the mapper becomes optional,
and within a sprint the domain model is whatever the table looks like.

---

## Correlation Identifier

**Problem.** One user action crosses the gateway, a service, a broker, and
another service. Without a shared id, four sets of logs cannot be joined.

**Mechanism.** `x-correlation-id` on the wire, `correlationId` in CLS
(`nestjs-cls`), minted fresh at the gateway and trusted inbound everywhere else.
Every log line carries it. It crosses gRPC via
`createGrpcMetadataWithCorrelation()` and AMQP via `injectCorrelationId()` /
`extractCorrelationId()`.

An event carries it as a **first-class envelope field**, not only as a header —
an async flow is exactly where CLS does not reach, and exactly where you most
need to trace a request. A consumer restores it into its own CLS context so the
email it sends logs under the sign-up that caused it.

**Lives in** `libs/common/src/correlation/` and
`libs/messaging/src/amqp-headers.ts`.
