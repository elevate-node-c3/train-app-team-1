# Messaging runbook

Operating the event backbone: inspecting the outbox, reading and replaying the
dead-letter queue, measuring the BR-03 latency, and running the three review
demos.

> **Status.** The backbone is landed: identity's outbox and relay, the shared
> retry/DLQ topology, notification's idempotent consumer, the BR-03 gate and the
> three demos all run against the current repo. `npm run test:e2e` drives the
> demos and the latency run non-interactively. The only piece that is **not**
> here is the automated replay tool, which remains Sprint 5; the manual shovel
> below works today.

---

## Setup

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps            # 11 containers: 7 services + postgres, redis, rabbitmq, mailpit
```

Three host addresses, and nothing else:

| What | URL | Credentials |
|---|---|---|
| Gateway (the only app port) | http://localhost:3000 | — |
| RabbitMQ management | http://127.0.0.1:15672 | `train_app` / `train_app` (`RABBITMQ_USER`/`_PASSWORD`) |
| Mailpit | http://127.0.0.1:8025 | — |

Postgres and Redis publish no port at all — reach them with
`docker compose exec`.

**`--wait` is not an app-readiness gate.** Compose only understands the four
infrastructure healthchecks; the seven app containers declare none, so
`docker compose up --wait` can return before a consumer has attached.

### Shell helpers

Paste these into your shell first; every command below uses them.

```bash
# The gateway is the only app port published to the host, so sign-up is a plain
# curl; `-w` prints the status and total time used by the demo timing claims.
signup () {   # signup <correlation-id> <email> [language]
  curl -sS -w '\n%{http_code} %{time_total}s\n' \
    -X POST "http://localhost:${GATEWAY_PORT:-3000}/identity/sign-up" \
    -H 'content-type: application/json' \
    -H "x-correlation-id: $1" \
    -d "{\"email\":\"$2\",\"language\":\"${3:-ar}\"}"
}

psql_id () { docker compose exec -T postgres psql -U postgres -d identity     -At -c "$1"; }
psql_nt () { docker compose exec -T postgres psql -U postgres -d notification -At -c "$1"; }

rmq () {     # rmq <api-path>   e.g. rmq queues/%2F
  curl -su "${RABBITMQ_USER:-train_app}:${RABBITMQ_PASSWORD:-train_app}" \
    "http://127.0.0.1:${RABBITMQ_MANAGEMENT_PORT:-15672}/api/$1"
}

delivered () {  # delivered <queue> -> broker counter; management stats lag a few seconds
  rmq "queues/%2F/$1" | jq '.message_stats.deliver_get // .message_stats.deliver // 0'
}

mailpit_count () { curl -s "http://127.0.0.1:${MAILPIT_UI_PORT:-8025}/api/v1/messages" | jq '.messages | length'; }
mailpit_clear () { curl -sX DELETE "http://127.0.0.1:${MAILPIT_UI_PORT:-8025}/api/v1/messages"; }
```

`psql` here uses the **superuser** deliberately: it is an operator tool and
needs to read either database. The services themselves hold only their own
credentials, which `test/e2e/database-isolation.e2e-spec.ts` proves.

### Wait for readiness

Now that the helpers are defined, wait for the two things Compose cannot tell
you:

```bash
until [ "$(curl -s http://localhost:3000/health/ready | jq -r '.status')" = "ready" ]; do
  sleep 1
done
until [ "$(rmq 'queues/%2F/notification.verification-code-issued' | jq '.consumers')" = "1" ]; do
  sleep 1
done
```

The gateway's `/health/ready` **reports** aggregate status; it does not return
`503` when a downstream is down, so `curl -f` only proves the gateway is
listening. Check the `status` field. A `ready` report proves every service's own
Postgres/broker check passed, but it does **not** prove the subscription bound —
a consumer that failed to bind still reports healthy, which is why
`test/e2e/support/stack.ts` checks the queue's `consumers` count separately
before running a demo.

---

## Inspecting the outbox

**Is there a backlog?** Anything with a non-null `published_at` is done; the
relay only ever looks at the rest.

```bash
psql_id "select count(*) from outbox_event where published_at is null"
```

**What is stuck, and why?**

```bash
psql_id "
  select id, event_type, attempt_count,
         to_char(occurred_at,     'HH24:MI:SS') as occurred,
         to_char(next_attempt_at, 'HH24:MI:SS') as next_try,
         left(coalesce(last_error, ''), 60)     as err
    from outbox_event
   where published_at is null
   order by occurred_at
   limit 20"
```

Read it like this:

| Symptom | Meaning |
|---|---|
| `attempt_count = 0`, `next_try` in the past, row sitting there | The relay is not running. Check `OUTBOX_RELAY_ENABLED` and `docker compose logs identity`. |
| `attempt_count` climbing, `err` mentions a connection | The broker is unreachable. Expected during an outage; it will drain on recovery. Backoff caps at 5s. |
| `attempt_count` climbing, `err` mentions Postgres | The relay cannot mark rows published. Check the DataSource initialised (see [ADR-0002](adr/0002-relay-claims-with-skip-locked.md) on `manualInitialization`). |
| `occurred_at` far in the past, everything else normal | A long broker outage drained slowly. Note that codes older than `VERIFICATION_CODE_TTL_SECONDS` will be *skipped* by the consumer, not emailed. |

**Never** edit `payload` by hand — it holds a live verification code. If you
need to retire a stuck row, mark it published; do not delete it, so the audit
trail survives.

**Force a republish** (this is also demo 2 below):

```bash
psql_id "update outbox_event set published_at = null, next_attempt_at = now() where id = '<uuid>'"
```

Safe by construction: the consumer deduplicates on the envelope id, so a
republish produces at most one additional email — and if the original was
already handled, zero.

---

## Reading the dead-letter queue

**Queue depths at a glance:**

```bash
rmq 'queues/%2F' | jq -r '.[] | "\(.messages)\t\(.name)"' | sort -rn
```

`%2F` is the URL-encoded default vhost `/`.

| Queue | A non-zero depth means |
|---|---|
| `notification.verification-code-issued` | Normal if transient — the consumer is behind or down. Persistent ⇒ the consumer is not consuming. |
| `...retry.1000` / `.3000` / `.9000` | Messages waiting out a TTL. Transient by design; they drain themselves. Persistent ⇒ attempts are failing repeatedly. |
| `...dlq` | **Needs a human.** Nothing drains this automatically. |

**Read a dead-lettered message without consuming it** — `ackmode: reject_requeue_true`
puts it back:

```bash
curl -su "${RABBITMQ_USER:-train_app}:${RABBITMQ_PASSWORD:-train_app}" \
  -H 'content-type: application/json' \
  -d '{"count":5,"ackmode":"reject_requeue_true","encoding":"auto"}' \
  "http://127.0.0.1:${RABBITMQ_MANAGEMENT_PORT:-15672}/api/queues/%2F/notification.verification-code-issued.dlq/get" \
  | jq -r '.[] | {reason: .properties.headers["x-death-reason"],
                  attempt: .properties.headers["x-attempt"],
                  correlationId: .properties.headers["x-correlation-id"],
                  id: (.payload | fromjson | .id),
                  type: (.payload | fromjson | .type)}'
```

Note what is deliberately **not** in that output: the payload's `code`. Do not
print `.payload` whole into a shared terminal or a ticket — a dead-lettered
message can still contain a live code for up to ten minutes.

`x-death-reason` tells you what to do:

| Reason | Meaning | Action |
|---|---|---|
| `invalid-payload` | A required field was missing or malformed. | A producer bug. Fix the producer; these messages are unreplayable. |
| `unsupported-version` | The envelope's `version` is newer than this consumer. | Deploy the consumer that understands it, **then** replay. |
| `retries-exhausted` | Four attempts failed. Usually a dependency outage. | Check the dependency, then replay — but see the expiry caveat. |

**The expiry caveat.** A verification code is dead ten minutes after issuance.
Replaying a dead-lettered `verification-code.issued` after that window produces
no email at all — the handler records `skip_reason='code_expired'` and sends
nothing, by design ([ADR-0003](adr/0003-duplicate-email-over-missing-email.md)).
That is correct behaviour, not a failure: an email containing a dead code is
worse than no email. For these, the user re-requests. Replay matters for the
events that are *not* time-bounded, which is most of the catalogue.

### Replaying (manual today)

An automated replay tool is **not** part of this delivery; it remains Sprint 5.
What exists now is the guarantee that makes it possible: every dead-lettered
message retains its full envelope, its `x-death-reason`, its `x-attempt` count
and its `x-correlation-id`, so nothing is lost by waiting.

Manual replay in the meantime — shovel from the DLQ back to the main queue via
the requeue exchange:

```bash
RMQ_URI="amqp://${RABBITMQ_USER:-train_app}:${RABBITMQ_PASSWORD:-train_app}@rabbitmq/%2F"
curl -su "${RABBITMQ_USER:-train_app}:${RABBITMQ_PASSWORD:-train_app}" \
  -H 'content-type: application/json' \
  -d "{\"value\":{\"src-uri\":\"$RMQ_URI\",
                \"src-queue\":\"notification.verification-code-issued.dlq\",
                \"dest-uri\":\"$RMQ_URI\",
                \"dest-exchange\":\"train.events.requeue\",
                \"dest-exchange-key\":\"notification.verification-code-issued\",
                \"src-delete-after\":\"queue-length\",\"ack-mode\":\"on-confirm\"}}" \
  -X PUT "http://127.0.0.1:${RABBITMQ_MANAGEMENT_PORT:-15672}/api/parameters/shovel/%2F/replay-verification-codes"
```

The shovel runs inside the RabbitMQ node, so `rabbitmq` is the broker hostname
and the URI carries the same credentials as the management call.
`src-delete-after: queue-length` drains exactly what was there when the shovel
started, so messages that fail again and land back in the DLQ are not
re-shovelled into a loop. Delete the shovel when it is done:

```bash
curl -su "${RABBITMQ_USER:-train_app}:${RABBITMQ_PASSWORD:-train_app}" \
  -X DELETE "http://127.0.0.1:${RABBITMQ_MANAGEMENT_PORT:-15672}/api/parameters/shovel/%2F/replay-verification-codes"
```

Replay is always safe to attempt: idempotency means an already-handled event
produces no second email.

---

## Measuring BR-03 latency

**The target.** OTP delivery within 30 seconds, reported as the worst case and
the 95th percentile over a run.

**What is measured.** `issued_at` is the envelope payload's `issuedAt`, stamped
by `identity` **inside the sign-up transaction** at the moment the code is
created — so the clock starts at issuance, not at publish, and the relay's own
delay is inside the measurement rather than hidden before it. `accepted_at` is
taken immediately after `sendMail` resolves, i.e. after Mailpit returns SMTP
`250`. Both are stored on `email_delivery` along with their difference.

Both containers share the host clock under Compose, so no skew correction is
needed. A multi-host deployment would need one, and this is where you'd add it.

```bash
psql_nt "
  select count(*)                                                     as sent,
         percentile_cont(0.50) within group (order by latency_ms)::int as p50_ms,
         percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms,
         max(latency_ms)                                              as worst_ms
    from email_delivery
   where outcome = 'accepted'"
```

Expect `p50` in the low hundreds of milliseconds on a laptop: the relay polls
every 500ms and Mailpit accepts immediately. The 30-second target exists for the
*retry* path, whose arithmetic is bounded at 25.5s:

```
OUTBOX_POLL_INTERVAL_MS   =  500   worst-case wait for the relay to see a committed row
EVENT_HANDLER_TIMEOUT_MS  = 3000   hard cap per attempt (= the SMTP socket timeout)
EVENT_RETRY_DELAYS_MS     = 1000, 3000, 9000   -> 4 attempts total

500 + 4 x 3000 + (1000 + 3000 + 9000) = 25 500 ms  <  30 000   (4 500 ms headroom)
```

`test/unit/amqp-topology.spec.ts` asserts that inequality, so raising any delay
past the budget is a red build rather than a silent regression. **The budget
assumes a healthy broker**: a RabbitMQ outage moves the clock start to broker
recovery, which is a separate availability statement and is not folded into
BR-03.

The skipped and failed rows matter too — a clean run has none:

```bash
psql_nt "select outcome, count(*) from email_delivery group by outcome"
psql_nt "select status, skip_reason, count(*) from processed_event group by 1,2"
```

---

## The three demos

The happy path is uninteresting. These are the demos for review, and
`test/e2e/outbox-event-backbone.e2e-spec.ts` runs them non-interactively. The
commands poll with `until` rather than sleeping a fixed time, so they wait
indefinitely on a broken stack — Ctrl-C and run the inspection queries above if
one does not settle.

### Demo 1 — the consumer is down, and nothing is lost

Proves: *down is not broken*. Sign-up stays fast because it never waits on
email, and the message is durable.

```bash
mailpit_clear
docker compose stop notification

signup demo-1 user1@example.com en
#   -> 201, comfortably under 1000ms. identity never called notification.

until [ "$(psql_id "select published_at is not null from outbox_event order by occurred_at desc limit 1")" = "t" ]; do
  sleep 1
done
psql_id "select published_at is not null as published from outbox_event
          order by occurred_at desc limit 1"
#   -> t    the relay published while the consumer was down

until [ "$(rmq 'queues/%2F/notification.verification-code-issued' | jq '.messages')" -ge 1 ]; do
  sleep 1
done
rmq 'queues/%2F/notification.verification-code-issued' | jq .messages
#   -> 1    parked in the durable queue, waiting

docker compose start notification
# wait for the subscription to attach, not a fixed sleep:
until [ "$(rmq 'queues/%2F/notification.verification-code-issued' | jq '.consumers')" = "1" ]; do
  sleep 1
done
until [ "$(mailpit_count)" -ge 1 ]; do sleep 1; done
curl -s "http://127.0.0.1:${MAILPIT_UI_PORT:-8025}/api/v1/messages" | jq '.messages[0] | {To, Subject}'
#   -> the email, in English because the account's language was 'en'
```

**Use `stop`, not `rm`.** `stop` keeps the durable queue. A removed consumer
whose queue never existed would have had its events dropped at the exchange —
that is the deliberate cost of not setting `mandatory` on publish, documented
under Publish/Subscribe in [design-patterns.md](design-patterns.md).

### Demo 1b — the broker is down

```bash
docker compose stop rabbitmq
signup demo-1b user1b@example.com ar
#   -> still 201, still fast. the commit does not depend on the broker.

psql_id "select published_at is not null as published, attempt_count,
                left(coalesce(last_error,''),40)
           from outbox_event order by occurred_at desc limit 1"
#   -> f|n|connect ECONNREFUSED ...    the commit succeeded; publish is retrying

docker compose start rabbitmq
# the broker takes a few seconds to accept connections; the relay then retries
# on its backoff (capped at 5s), so poll rather than sleeping a fixed time.
until [ "$(psql_id "select published_at is not null from outbox_event order by occurred_at desc limit 1")" = "t" ]; do
  sleep 1
done
psql_id "select published_at is not null from outbox_event order by occurred_at desc limit 1"
#   -> t
```

**Run this demo last, or restart `notification` afterwards.** When the broker
itself restarts, the consumer's channel closes and the consumer does not
re-subscribe on its own; `docker compose restart notification` reattaches it
(the queue's `consumers` count returns to 1). `test/e2e/outbox-event-backbone.e2e-spec.ts`
orders the specs so demo 1b runs last for exactly this reason.

### Demo 2 — the same event twice, exactly one email

Proves BR-54. The duplicate is *real*: re-arming the outbox row makes the relay
republish the byte-identical envelope with the same id, which is exactly what a
crashed relay would do.

```bash
mailpit_clear
signup demo-2 user2@example.com ar
until [ "$(mailpit_count)" -ge 1 ]; do sleep 1; done
mailpit_count                 # -> 1

ID=$(psql_id "select id from outbox_event order by occurred_at desc limit 1")
BEFORE=$(delivered notification.verification-code-issued)
psql_id "update outbox_event set published_at = null, next_attempt_at = now() where id = '$ID'"

# wait for the relay to re-publish, then for the broker's counter to move.
# Management stats lag the broker by a few seconds, hence the poll.
until [ "$(psql_id "select published_at is not null from outbox_event where id = '$ID'")" = "t" ]; do
  sleep 1
done
until [ "$(delivered notification.verification-code-issued)" -gt "$BEFORE" ]; do
  sleep 1
done
# and wait for the consumer to ack it, so the next read sees a settled queue
until [ "$(rmq 'queues/%2F/notification.verification-code-issued' | jq '.messages')" = "0" ]; do
  sleep 1
done

mailpit_count                 # -> still 1
psql_nt "select status, attempt_count from processed_event where event_id = '$ID'"
#   -> handled|1
```

`attempt_count = 1` is **expected**, and it is not a failed demo. The claim
statement only re-claims a `failed` row, or a `processing` row whose lease
expired; a `handled` row is refused, so the duplicate is acknowledged without
being handled a second time and the counter does not move.

The proof that the second delivery really reached the consumer is the broker's
own `message_stats.deliver_get`, which incremented while `mailpit_count` stayed
at 1. A duplicate that never arrived would leave both unchanged.
`test/e2e/outbox-event-backbone.e2e-spec.ts` asserts exactly this: `deliver_get`
grows, `processed_event.attempt_count` stays `1`, and Mailpit holds one
message.

### Demo 3 — the latency report

```bash
mailpit_clear
for i in $(seq 1 25); do signup "lat-$i" "lat$i@example.com" en; done
until [ "$(mailpit_count)" -ge 25 ]; do sleep 1; done
mailpit_count                 # -> 25
```

Then the percentile query from the previous section.
`test/e2e/outbox-latency.e2e-spec.ts` runs the same 25, logs
`sent / p50 / p95 / worst`, and **asserts `p95 < 30000` and `worst < 30000`** —
BR-03 is a build gate, not a paragraph in a report.

---

## Other things that will happen

**A poison message.** Publish an event with a bad version and watch it skip the
retry queues entirely:

```bash
psql_id "
  insert into outbox_event
    (id, event_type, event_version, routing_key, payload,
     correlation_id, producer, occurred_at)
  values
    (gen_random_uuid(), 'identity.verification-code.issued', 99,
     'identity.verification-code.issued', '{}'::jsonb,
     'poison-demo', 'identity', now())"

until [ "$(rmq 'queues/%2F/notification.verification-code-issued.dlq' | jq '.messages')" = "1" ]; do
  sleep 1
done
rmq 'queues/%2F/notification.verification-code-issued.dlq' | jq .messages   # -> 1
rmq 'queues/%2F/notification.verification-code-issued'     | jq .messages   # -> 0, head is free
```

Both numbers matter: it dead-lettered *and* it did not block the queue behind
it. The dead letter's `x-death-reason` is `unsupported-version` (print it with
the read command above); a version mismatch is classified as permanent, so it
never touched a retry queue.

**The consumer was down for twenty minutes.** The queued messages are delivered
and every one is *skipped*, not emailed:

```bash
psql_nt "select skip_reason, count(*) from processed_event
          where status = 'skipped' group by 1"
#   -> code_expired | n
```

No DLQ, no retry storm. The code was dead; sending it would have been worse than
silence.

**Rows stuck in `processing`.** A crash leaves the claim held until the lease
expires or a redelivery takes it over. If rows are stuck with no redelivery
coming, the message was acked and the handler died after — a bug worth
investigating, not a routine state:

```bash
psql_nt "select event_id, attempt_count, claimed_at from processed_event
          where status = 'processing' and claimed_at < now() - interval '5 minutes'"
```

---

## Topology reference

Declared in code by its owner
(`libs/messaging/src/amqp-topology.ts`), asserted idempotently on every boot.
**Nothing here is created by hand in the management console** — a rebuilt broker
is identical, and a topology change is reviewable in a diff.

Ownership matters: the producer owns `train.events` and declares no queues; each
consumer owns its retry/requeue/DLX exchanges and its own queues. A consumer
also **re-asserts `train.events` with the producer's exact parameters** so
startup order is irrelevant — binding to an exchange that does not exist yet
fails with `404 no exchange 'train.events'`, which would leave the consumer
subscribed to nothing. The duplicate assertion is not a transfer of ownership;
the exchange's definition is still the producer's.

```
train.events          topic    <- identity publishes here
train.events.retry    direct   <- failed attempts land here to wait out a TTL
train.events.requeue  direct   <- TTL expiry routes back onto the main queue
train.events.dlx      direct   <- terminal failures

notification.verification-code-issued                 bound: train.events <- identity.verification-code.issued
                                                             train.events.requeue <- notification.verification-code-issued
notification.verification-code-issued.retry.{1000,3000,9000}   x-message-ttl, dlx -> requeue
notification.verification-code-issued.dlq             no ttl, no dlx (terminal)
```

Every consumer gets **its own queue**. A second service interested in this event
declares another queue and changes nothing in `identity`.
