# Booking Service

Booking owns what a traveller is assembling: the passengers, the trains, the
locked price, the hold on the seats and the charge. One row carries all of it.

## One aggregate

There is a single table, `booking_draft`. The draft and its hold are the same
thing, so there is no second row to keep in step:

- `hold_intent`, `passenger_snapshot`, `hold_id`, `hold_state`, `hold_version`,
  `hold_snapshot` — the hold, owned by the draft module (MT-02)
- `flow_state`, `idempotency_key`, `quoted_legs`, `travel_class`, the three
  `*_piastres` columns, `terms_accepted_at`, `payment_reference` — checkout
- `compensation_*`, `hold_released`, `charge_cancelled`, `late_payment` — what
  is still owed if the booking does not complete
- `resume_next_attempt_at`, `lease_until`, `lease_owner` — the worker's claim

`status` is the draft's lifecycle, `hold_state` mirrors inventory's hold, and
`flow_state` is how far checkout has reached. They answer different questions.

Events go to the standard `outbox_event` table the messaging relay drains.
Inbound hold events are de-duplicated by `processed_event`. Neither is
booking-specific.

## Modules

`modules/draft` owns the hold: it resolves the owner's saved passengers through
identity, calls inventory's `CreateHold` once for every leg and passenger, and
keeps the booking key, the version fencing and the reconciliation that a
timeout needs. `resolveAndHold` is the one implementation of that step.

`modules/flow` owns checkout, in the shape catalog uses — one concern per file:

| File | Holds |
| --- | --- |
| `booking-flow.repository.ts` | every write to `booking_draft` |
| `booking-flow.service.ts` | the state machine, and no SQL |
| `booking-flow.worker.ts` | the expiry, resume and compensation sweeps |
| `booking-flow.validator.ts` | `validateSubmit`, the idempotent-retry check |
| `booking-flow.response.ts` | the Review Tickets answer |
| `booking-flow-events.factory.ts` | the typed event envelopes |
| `booking-flow-error.ts`, `to-rpc-exception.ts` | the refusal, and its status |
| `booking-total.ts` | the booking fee and total (BR-31) |

## The flow

```
quote_pending → price_locked → hold_pending → seats_held
                                                  ↓ terms accepted
                                          payment_starting → awaiting_payment
```

`expired`, `abandoned` and `failed` are terminal and owe compensation.

1. **Submit.** The submission is validated before anything is read or held. A
   repeated submit resumes the booking it already made — the unique
   `(user_id, idempotency_key)` index makes a concurrent duplicate a no-op, so
   both requests land on one booking, and a retry is never refused by a later
   passenger edit. A key reused for different content is a conflict.
2. **Quote.** Catalog returns the per-passenger fare and class. The price is
   locked here (BR-30): a later fare change never reaches this booking. The
   server re-checks that a return leg departs after the outbound arrives
   (D7, BR-20).
3. **Hold.** One `CreateHold` for every leg and passenger. Inventory commits
   them together, so a failed return leg is one refusal — there is no partial
   hold to unwind, and no per-leg compensation to get wrong.
4. **Terms.** Recorded once, with its time. The server is the guard: no
   recorded acceptance, no charge.
5. **Pay.** The charge starts, then the hold decides whether the traveller may
   still pay — it can run out while payment is starting.

A step that fails transiently keeps its place for the worker. Anything else is
an answer, and names the train or passenger it is about (BR-57).

## Giving it back

Compensation returns what the booking took, seats before charge, both
idempotent so a retry repeats them. A charge that succeeds while compensating
is recorded as a late payment and alerted, not retried — it needs a human.
After the retry budget the booking is written to
`booking_compensation_dead_letter`, and retrying continues.

Abandoning releases immediately rather than waiting for the hold to lapse
(BR-25).

## Clients

Catalog and payment are called from the flow. Inventory and identity are the
draft module's, so the hold has one caller.

```
CATALOG_GRPC_URL   PAYMENT_GRPC_URL
INVENTORY_GRPC_URL IDENTITY_GRPC_URL   (draft module)
```

## Tickets (TA-108)

The confirmation saga issues one ticket per passenger per leg; `modules/tickets`
owns everything after that. Each ticket row carries its own `snapshot` — the
passenger, the train, the class in plain words (both languages), the
passenger's own boarding and alighting stations with their Cairo times, and the
fare — copied once from what the draft locked at the quote. Nothing is read
back from identity or catalog, so a renamed passenger or a republished
timetable never reaches an issued ticket.

| File | Holds |
| --- | --- |
| `ticket-snapshot.ts` | the snapshot and the QR's claims, built at issuance |
| `services/ticket-signer.service.ts` | the only holder of the signing key |
| `services/tickets.service.ts` | ownership (BR-09), what each ticket allows (BR-39), the conductor's check |
| `tickets.repository.ts` | every read; one statement per page, never cached |
| `ticket-view.ts` | the card, the shared view and the event's ticket |
| `ticket-document.ts`, `ticket-pdf.ts`, `bidi-text.ts` | the printed ticket, English or Arabic (right to left) |

**The QR** is a compact JWS over Ed25519, `typ: ticket-qr`, naming its key in
`kid`. It carries the train, the boarding date at the passenger's own station,
both stations, coach, seat, name and the last four National ID digits —
booking never holds more of the ID than identity's mask. Conductors fetch the
public keys from `GET /api/v1/ticket-verifications/keys` and verify offline. An
offline check proves the QR is genuine, **not** that the ticket is still valid:
a ticket cancelled after the scanner last synced still verifies offline.
`POST /api/v1/ticket-verifications` is the online check, against the ticket's
current row.

**Share links** are the same kind of token, `typ: ticket-share`, naming one
ticket and expiring when the passenger arrives. Booking re-reads the ticket on
every open, so a cancellation ends the link at once.

**Keys.** `npm run keys:generate` writes the development key that Compose
mounts. To rotate, set a new `TICKET_SIGNING_KEY_ID` and private key, and list
the old public key in `TICKET_RETIRED_PUBLIC_KEYS` for as long as tickets it
signed may still be travelled on.

```
TICKET_SIGNING_KEY_ID              TICKET_SIGNING_PRIVATE_KEY(_FILE)
TICKET_RETIRED_PUBLIC_KEYS         {"<old kid>":"<public PEM>"}
```
