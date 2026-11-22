# Finding a booking charged without a ticket

A traveller whose payment succeeded ends with tickets for real seats or
with every piastre back. Between those two outcomes, a `booking_draft` row
can sit charged but unsettled — the confirmation saga hasn't finished
(`confirming` / `refunding`), never because it finished wrong. §2 of the
confirmation-saga design calls leaving a charged traveller without an
outcome an anti-goal, so this must be detectable, not just theoretically
impossible.

## What makes a row "charged without an outcome"

```sql
SELECT id, saga_step
  FROM booking_draft
 WHERE payment_succeeded_at IS NOT NULL
   AND flow_state NOT IN ('confirmed', 'refunded')
   AND payment_succeeded_at <= now() - interval '60 seconds'
 ORDER BY payment_succeeded_at;
```

This is exactly `BookingFlowRepository.findChargedWithoutOutcome(olderThanSeconds)`,
which uses the partial index `idx_booking_draft_charged_unsettled`
(`ON booking_draft (payment_succeeded_at) WHERE payment_succeeded_at IS NOT NULL
AND flow_state NOT IN ('confirmed', 'refunded')`). The index supports the
query; PostgreSQL may still choose a sequential scan for a small table.

### Columns, in plain terms

| Column                 | Meaning                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment_succeeded_at` | Set once, by `beginConfirming`, the instant the saga starts. Never null once a payment has been verified.                                                                                                      |
| `flow_state`           | `confirming` or `refunding` while the saga is still working; `confirmed` or `refunded` once it reaches its outcome. These two pairs are exhaustive — there is no third resting state for a charged booking.    |
| `saga_step`            | Where inside the saga the row is stuck: `payment_recorded` (hasn't called `SettleHold` yet), `settled` (knows the outcome, hasn't confirmed or started refunding), or `refunding` (waiting on `RefundCharge`). |
| 60 seconds             | Not a timeout on the saga itself — the worker resumes every step every scan — but the threshold past which "still charged" stops being normal in-flight latency and starts being worth a human's attention.    |

## The three ways to ask

1. **Logs.** Every scan (`BookingFlowWorker.scan`), after expiring due
   holds, resuming stalled flows, and running compensations, the worker
   calls `logChargedWithoutOutcome()`, which logs one line per row at
   error level:

   ```
   ALERT: booking {id} was charged and is still {sagaStep}
   ```

   This reaches whatever already watches booking's error logs, with no new
   infrastructure.

2. **An HTTP read.** `GET /booking` (`ServiceInfoController`) answers:

   ```json
   {
     "success": true,
     "data": {
       "service": "booking",
       "status": "operational",
       "chargedWithoutOutcome": 0
     },
     "message": "...",
     "error": null,
     "correlationId": "...",
     "timestamp": "..."
   }
   ```

   Query `data.chargedWithoutOutcome` inside the standard HTTP envelope,
   for example `curl -fsS http://localhost:<booking-http-port>/booking | jq '.data.chargedWithoutOutcome'`.
   This count is `findChargedWithoutOutcome(60).length`, read
   live — not a stored counter — so it can never drift from the database. A
   non-zero number here is the same alarm the logs raise, in a shape a
   health check or a dashboard can poll.

3. **The query itself.** Anyone with database access runs the SQL above
   directly, for example during an incident, to see exactly which bookings
   are stuck and for how long — `saga_step` says precisely which remote
   call (`SettleHold` or `RefundCharge`) to go check.

There is deliberately no hand-rolled metrics counter (the house pattern,
e.g. `libs/common/src/cache/cache-metrics.ts`, exists for high-frequency
per-request hit/miss counting with cross-instance aggregation). A worker
scan every two seconds producing a handful of rows doesn't need that
machinery; a live read of the same repository method both the logs and the
health check already call is the cheapest answer that is still a number
someone can watch.

## Payment Recovery Before Booking

The booking query starts counting only after booking records verified payment.
`GET /payment` also exposes `data.pendingStripeEvents`,
`data.rejectedStripeEvents`, and `data.intentRecoveryProblems`. These cover an
unmatched verified success or ambiguous Stripe creation before booking can see
it. Pending inbox entries and intent recovery are processed automatically after
a restart; rejected amount/currency evidence repeatedly emits an error-level
alarm rather than confirming a booking.

On payment's database, find creation requests that need investigation:

```sql
SELECT id, booking_reference, stripe_payment_intent_id,
       intent_creation_started_at, intent_creation_last_error
FROM payment_charge
WHERE status = 'started' AND intent_creation_last_error IS NOT NULL
ORDER BY intent_creation_started_at NULLS LAST;
```

Creation retries have a 23-hour safety margin. After that, an empty Stripe
metadata search is not proof that no intent exists, so recovery refuses to
create another intent and raises an alarm. Reconcile the existing Stripe intent
to the payment reference instead of clearing the claim and blindly charging
again.

Booking's `payment_event_id` joins payment's `stripe_event.id`: it is either
the signed Stripe event id or a stable `reconciled:<intent>:succeeded` receipt
from an authenticated Stripe retrieve. `saga_attempts` records consecutive
failures of the current step and drives capped exponential retry. After twelve
failures, `booking_compensation_dead_letter` records the booking, attempt count,
and error for investigation; retry continues because the money is still owed.

## Recipient Recovery

Configure the same distinct, at least 32-character
`NOTIFICATION_IDENTITY_SERVICE_KEY` in identity and notification. Historical
profiles with no email recover it from the private identity RPC on demand.
Missing recipient data and SMTP failures retry durably.

Critical events remain pending in the outbox until a durable consumer binding
exists; this never delays the booking transaction. Events already discarded or
permanently skipped before this fix require explicit operator reconciliation
and replay from their original outbox, including resetting a terminal
notification inbox skip where applicable.
