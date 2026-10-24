# ADR-0001 — Events are written in the business transaction, not published from it

**Status:** Accepted · **Date:** 2026-10-24 · **Scope:** every service that publishes an event

## Context

`AUTH-2`'s sign-up response tells the client "We Have Sent Code To Your Email".
That response goes back to the client *before* the email exists. The backend has
to keep the promise afterwards, and the research measured how badly the old app
kept it: 3 of 4 users could not find the code. The redesign's target is OTP
delivery 100% within 30 seconds (BR-03).

The obvious implementation is two writes:

```ts
await repo.save(account);           // Postgres
await rabbit.publish(event);        // RabbitMQ
```

This is the **dual write**, and it has no correct ordering:

- Publish after the commit, and a crash in between loses the event. The account exists, the code is stored, and no email will ever be sent. The user is stuck with an account they cannot verify.
- Publish before the commit, and a rollback leaves an event announcing a change that never happened. The user gets a code for an account that does not exist.
- Wrap both in a distributed transaction and you need 2PC across Postgres and RabbitMQ — unavailable here, and it would couple sign-up's availability to the broker's, which is exactly what we are trying to avoid.

The forces in tension: sign-up must return fast and must not depend on RabbitMQ
or on `notification` being up; the event must never be lost once the business
change is committed; and the event must never exist if the change was rolled
back.

## Decision

**The event is written as a row in the producer's own database, in the same
transaction as the business change it describes.** A separate relay publishes
it afterwards.

```ts
await dataSource.transaction(async (manager) => {
  await manager.save(account);
  await manager.save(verificationCode);
  await outbox.append(manager, envelope);   // same manager => same transaction
});
```

Three structural rules enforce it:

1. **A repository that participates in a caller's transaction takes an `EntityManager` parameter** and never opens its own. `OutboxRepository.append(manager, envelope)` cannot escape the caller's transaction, and a test asserts it never receives a `DataSource`.
2. **The use-case has no publisher in its constructor.** No `EventPublisherService`, no `AmqpClientService`, no notification client. You cannot publish from inside the transaction if there is nothing to publish with, and a test asserts the constructor's injected tokens.
3. **The outbox row's primary key is the envelope's `id`**, so one identity flows from the producer's transaction all the way to the consumer's `processed_event` table.

## Consequences

**Bought:**

- If the transaction rolls back, the event never existed. If it commits, the event *will* be published even if the process dies the next instant — the row is durable and unclaimed, and any relay instance picks it up.
- Sign-up's latency and availability are independent of RabbitMQ and of `notification`. Both can be down and sign-up still returns 201 at normal speed.
- The outbox table is an audit trail: what was emitted, when, and whether it landed.

**Cost:**

- Publishing is asynchronous and **at-least-once**. Every consumer must be idempotent — that is not optional, it is the price of this pattern. See [ADR-0003](0003-duplicate-email-over-missing-email.md).
- Up to one poll interval (500ms) of added latency, inside the BR-03 budget.
- A table that grows. Pruning published rows is a later concern; the relay's index is partial (`WHERE published_at IS NULL`) so query performance does not degrade as history accumulates.
- Ordering is per-`occurred_at`, not globally guaranteed across a batch failure. No current consumer needs total ordering; one that does would need a per-aggregate sequence.

**Made impossible:** a committed business change with no event, and an event for
an uncommitted change. Those two bugs cannot be reintroduced without deleting a
test.

## Alternatives considered

**Publish after commit, accept the window.** Rejected: this is precisely the
failure the story exists to remove, and "the window is small" is not a
property — it is a hope. At sign-up volume a small window is a daily
occurrence.

**Publish inside the transaction.** Rejected: an event for a rolled-back
change is worse than a missing one, and it makes the commit depend on broker
availability.

**Two-phase commit across Postgres and RabbitMQ.** Rejected: not available in
this stack, and it would make sign-up fail when the broker is down — the
opposite of the required behaviour.

**Change Data Capture (Debezium reading the WAL).** Rejected for now: it gives
the same atomicity without an application-level table, but it adds Kafka
Connect or an equivalent to the infrastructure, puts the event's shape at the
mercy of the table's shape, and cannot be reasoned about from the application's
own tests. Revisit if the number of producers makes per-service relays
burdensome.

**`LISTEN`/`NOTIFY` instead of a table.** Rejected: notifications are not
durable. A listener that is down when the notify fires never learns about it,
which loses exactly the messages this ADR exists to protect.
