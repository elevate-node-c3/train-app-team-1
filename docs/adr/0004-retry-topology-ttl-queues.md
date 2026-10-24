# ADR-0004 — Delayed retries use per-attempt TTL queues, not the delayed-message plugin

**Status:** Accepted · **Date:** 2026-10-24 · **Relates to:** BR-03

## Context

A consumer failure is one of two kinds, and conflating them is the bug:

- **Transient** — SMTP is not answering, the database blipped. Retrying is correct, after a delay, a bounded number of times.
- **Permanent** — the payload is unparseable, the envelope version is unknown. Retrying is *forever wrong*; the message will never become valid.

Three requirements pull against each other:

1. Retries must be **delayed and growing**, so a dependency gets time to recover instead of being hammered.
2. A failing message must **never block the messages behind it** — a poison message that stalls a queue takes down every subsequent sign-up's email.
3. The total retry budget must fit inside **BR-03's 30 seconds**, because a verification code that arrives after the user has given up is worthless.

And two environmental constraints:

- `rabbitmq:4-management-alpine` does **not** ship `rabbitmq_delayed_message_exchange`. Installing it needs a custom image, which needs a `build:` stanza on the `rabbitmq` service — and `test/skeleton/compose.spec.ts` pins the shared-Dockerfile/no-extras shape.
- Dead-lettered messages must be **replayable** later (Sprint 5), so whatever we do must preserve enough context to replay.

## Decision

**Classify first, then route. Three outcomes, and both failure paths ack the
original message.**

| Failure | Route | Then |
|---|---|---|
| Permanent (`PermanentEventError`: `invalid-payload`, `unsupported-version`) | Straight to `train.events.dlx` with `x-death-reason` | **ack** — no retry, ever |
| Transient, attempts remain | Republish to the next per-attempt TTL retry queue with `x-attempt` incremented | **ack** |
| Transient, attempts exhausted | To `train.events.dlx` with `x-death-reason: retries-exhausted` | **ack** |

**Both paths ack the original.** That is requirement 2, and it is the whole
poison-message story: the queue head is never held by a failing message.
Combined with `prefetch = 10`, nothing queues behind a bad message.

**The delay mechanism is a retry queue with no consumer.** The message sits in
`notification.verification-code-issued.retry.3000`, whose `x-message-ttl` is
3000ms. When the TTL expires the broker dead-letters it to
`train.events.requeue`, a `direct` exchange keyed on the **main queue's name**,
which puts it back on the main queue. One queue per delay, three delays:

```
notification.verification-code-issued.retry.1000   x-message-ttl 1000
notification.verification-code-issued.retry.3000   x-message-ttl 3000
notification.verification-code-issued.retry.9000   x-message-ttl 9000
         all: x-dead-letter-exchange = train.events.requeue
              x-dead-letter-routing-key = notification.verification-code-issued
```

**One queue per delay, not one queue with per-message TTL.** A single queue with
`expiration` set per message is subject to head-of-line blocking: RabbitMQ only
examines the message at the *head*, so a 9-second message in front of a
1-second one delays it. Separate queues per delay make each one's TTL uniform
and the expiry order correct.

**Why the requeue exchange is `direct` and keyed on the queue name** rather than
dead-lettering back to the topic exchange on the original routing key: a topic
redelivery would fan *this* consumer's retry out to every other consumer later
bound to that key. Keying on the queue name re-targets exactly the consumer that
failed — which keeps "every consumer has its own queue" true under retry.

### The budget, which is a test not a comment

```
OUTBOX_POLL_INTERVAL_MS   =  500   worst-case wait for the relay to see a committed row
publisher confirm         ≈   10 ms
broker -> consumer        ≈    1 ms
EVENT_HANDLER_TIMEOUT_MS  = 3000   hard cap per attempt (= the SMTP socket timeout)
EVENT_RETRY_DELAYS_MS     = 1000, 3000, 9000   -> 4 attempts total

worst case (success on attempt 4, or dead-letter):
  500 + 4 x 3000 + (1000 + 3000 + 9000) = 25 500 ms  <  30 000   (4 500 ms headroom)
happy path: 500 + 10 + ~50 ≈ 560 ms
```

`test/unit/amqp-topology.spec.ts` asserts that inequality, so raising a delay
past the budget is a **red build** rather than a silent BR-03 regression. The
budget assumes a healthy broker; a RabbitMQ outage moves the clock start to
broker recovery, which is a separate availability statement and is deliberately
not folded into BR-03.

`EVENT_HANDLER_TIMEOUT_MS` doubles as the SMTP connection, greeting and socket
timeout — a hung SMTP connection must not consume the whole budget in one
attempt.

## Consequences

**Bought:** delayed growing retries with no plugin and no new infrastructure; a
poison message cannot block the queue; the retry attempt count travels with the
message so it survives a consumer restart; everything is declared in code and
reviewable in a diff.

**Cost:**

- Three extra queues per consumer per event type. Visible in the management UI, and verbose if a consumer handles many event types — a generated-name convention (`retryQueueName(queue, delayMs)`) keeps it manageable.
- Changing a delay changes a queue name, which means declaring a new queue; the old one lingers until deleted. Acceptable, and the alternative (mutable `x-message-ttl`) requires deleting and recreating the queue anyway, since queue arguments are immutable.
- Acking a failed message means the broker no longer tracks it — our republish *is* the retry. A crash between the republish and the ack yields a duplicate delivery, which idempotency absorbs. A republish that *fails* must therefore `nack(msg, false, true)` and never ack, or the message is lost; `test/unit/event-consumer.spec.ts` asserts this.

**Deliberately accepted:** a dependency outage longer than ~25 seconds
dead-letters the message. For a verification code this is correct — the code
expires in ten minutes, so stretching retries to cover a five-minute Mailpit
outage would deliver a code the user can no longer use. We would rather
dead-letter visibly and let the user re-request. The knob is
`EVENT_RETRY_DELAYS_MS`, and the budget test stops anyone pushing it past 30
seconds without a conscious decision.

## Alternatives considered

**`nack(requeue: true)` as the retry.** Rejected, and this is the classic
mistake: the message returns to the head of the queue instantly, with no delay
and no attempt count, and spins at full CPU forever — a livelock that also
blocks everything behind it. It fails all three requirements at once.

**`rabbitmq_delayed_message_exchange` plugin.** The idiomatic answer, and
rejected only for environment reasons: it is not in
`rabbitmq:4-management-alpine`, and adding it requires a custom image whose
`build:` stanza trips `test/skeleton/compose.spec.ts`. If a custom broker image
is introduced for another reason, this is worth revisiting — it would collapse
three queues per consumer into one exchange.

**In-process `setTimeout` before retrying.** Rejected: the delay is held in
memory, so a restart loses every pending retry; the message stays unacked and
counts against `prefetch`, so enough concurrent retries stall the consumer; and
nothing survives a deploy.

**A single retry queue with per-message `expiration`.** Rejected for
head-of-line blocking, described above.

**Unbounded retries.** Rejected: it converts a permanent failure into an
infinite loop and hides the problem. Bounded retries plus a DLQ make the failure
visible, countable, and replayable.
