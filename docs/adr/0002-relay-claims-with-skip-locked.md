# ADR-0002 — The relay claims outbox rows with `FOR UPDATE SKIP LOCKED`

**Status:** Accepted · **Date:** 2026-10-24 · **Depends on:** [ADR-0001](0001-transactional-outbox.md)

## Context

[ADR-0001](0001-transactional-outbox.md) leaves rows in `outbox_event` waiting
to be published. Something must publish them, and **more than one instance of a
service may be running** — the story requires us to decide how two relays avoid
competing for the same events.

Constraints:

- Duplicates are tolerated downstream (consumers are idempotent); **lost events are not**.
- A row must be marked published only after the broker has *confirmed* it, otherwise a nack silently loses the event.
- The relay must survive the broker being down, Postgres being briefly unreachable, and its own process dying mid-publish.
- It must not need a leader election, an external lock service, or an extra container — `test/skeleton/compose.spec.ts:100` forbids additional compose services.
- The pickup interval is part of the BR-03 budget and must be chosen, not defaulted.

## Decision

**A background loop claims a batch with `FOR UPDATE SKIP LOCKED`, publishes each
row, waits for the broker's confirm, and marks it published — all inside the
claiming transaction.**

```sql
SELECT id, event_type, event_version, routing_key, payload,
       correlation_id, producer, occurred_at, attempt_count
  FROM outbox_event
 WHERE published_at IS NULL AND next_attempt_at <= now()
 ORDER BY occurred_at
 LIMIT 20
   FOR UPDATE SKIP LOCKED;
```

Then per row: `await publisher.publish(...)` (which resolves only on the
broker's confirm) → `UPDATE outbox_event SET published_at = now()` → commit.

**`SKIP LOCKED` is the entire multi-instance story.** A second relay's `SELECT`
steps over rows already locked by the first rather than blocking on them, so two
relays make progress on disjoint batches with no coordination at all. The row
lock is **held across the publish**, which is why two relays never publish the
same row concurrently.

On a failed confirm: `attempt_count + 1`,
`next_attempt_at = now() + least(5s, 250ms · 2^attempt)`, store the error's
*message* (never the payload — it contains a live code), then **commit** to
release the lock and stop the batch.

Operational parameters, chosen against the 30-second budget:

| Parameter | Value | Why |
|---|---|---|
| `OUTBOX_POLL_INTERVAL_MS` | 500 | Worst-case pickup delay. 1.7% of the BR-03 budget — cheap insurance against a long tail. |
| `OUTBOX_BATCH_SIZE` | 20 | Keeps the lock window to roughly 20 × 5ms ≈ 100ms, so a sibling relay is never starved. |
| Backoff cap | 5s | A broker recovery is noticed within 5s rather than after an unbounded exponential climb. |

## Consequences

**Bought:** horizontal scaling with no coordination primitive; no leader
election, no advisory lock, no extra container; a crash releases the lock
automatically because it is a transaction row lock.

**Cost:**

- Up to 500ms of latency, and one query per interval per instance even when idle. At this volume, negligible.
- Ordering is best-effort (`ORDER BY occurred_at` within a batch). Two relays can publish concurrently, so global order is not guaranteed. No consumer needs it today; one that did would need a per-aggregate sequence and a single claimer per aggregate.
- The publish happens while a database transaction is open. The batch size is what bounds that, and it is why 20 rather than 500.

**Two implementation constraints that are easy to get wrong, both asserted by
`test/unit/outbox-relay.spec.ts`:**

1. **`manualInitialization: true` means nobody has initialised the DataSource.** Nest does not connect at boot (deliberately — a Postgres outage must degrade, not crash-loop). So each tick must begin with `if (!dataSource.isInitialized) await dataSource.initialize()`, wrapped so a Postgres-down boot logs and retries on the next tick rather than killing the process. Two components racing to `initialize()` throws `CannotConnectAlreadyConnectedError`, so the migration runner — which runs at `onApplicationBootstrap`, before the relay's first timer fires — owns initialisation, and the relay only checks the flag and catches.
2. **`setTimeout` self-rescheduling, never `setInterval`.** `setInterval` overlaps ticks, and two overlapping polls *in one process* will contend for the same rows — self-inflicted lock contention. `.unref()` the timer so a pending tick cannot hold the process open, hold the loop promise on a field (which also satisfies `oxlint`'s `no-floating-promises`), and `await` it in `beforeApplicationShutdown` so a deploy does not abandon an open claim. Nest calls that hook while the AMQP channel is still open; `onApplicationShutdown` runs after `dispose()`, too late to publish the last claim.

## Alternatives considered

**Advisory lock, one relay publishes at a time.** Rejected: it serialises
throughput for no benefit, and a crash holding a session lock creates a stall
until the session is reaped. `SKIP LOCKED` lets both instances work.

**Leader election (one active relay).** Rejected: needs a coordination
mechanism this stack does not have, adds a failover window during which nothing
publishes, and the problem it solves — double publishing — is already solved by
the row lock *and* tolerated by idempotent consumers.

**Claim by `UPDATE ... SET claimed_by = $instance RETURNING`.** Rejected: it
works, but it needs lease expiry logic to recover rows claimed by a dead
instance, which is a whole second mechanism. A transaction row lock is released
by the crash itself.

**`LISTEN`/`NOTIFY` to publish immediately instead of polling.** Rejected as
the *primary* mechanism — notifications are not durable, so a relay that is
down when one fires never learns about that row. Viable later as an *optimisation
on top of* polling (notify to wake the loop early, poll as the safety net) if
500ms ever matters.

**`waitForConfirms()` instead of a per-publish confirm callback.** Rejected:
it waits for *all* outstanding confirms on the channel, coupling unrelated
publishes' fates together — one slow message would delay marking every other
row in the batch.
