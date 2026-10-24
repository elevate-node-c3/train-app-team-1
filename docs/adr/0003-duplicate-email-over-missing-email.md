# ADR-0003 — On an ambiguous crash, risk a duplicate email rather than a missing one

**Status:** Accepted · **Date:** 2026-10-24 · **Relates to:** BR-54, BR-03

## Context

[ADR-0001](0001-transactional-outbox.md) gives us at-least-once delivery, so the
consumer must be idempotent: it records the ids of events it has handled and
skips any it has already handled, so the same event delivered twice produces one
email (BR-54).

But idempotency has a seam. Sending the email and recording the event as handled
are **two writes to two different systems** — Mailpit over SMTP, and
`notification`'s own Postgres. The same dual-write problem as ADR-0001, except
here there is no outbox available: an email, once accepted by an SMTP server,
cannot be rolled back.

So one ordering must be chosen, and each loses something:

**Record handled, then send.** A crash between them leaves the event marked
handled with no email ever sent. At-most-once. The message is acked or will be
skipped on redelivery, and nothing will ever retry. **A silently lost sign-up.**

**Send, then record handled.** A crash between them leaves the row
`processing` and the message unacked, so the broker redelivers it, the
redelivery takes the claim over, and a **second identical email** is sent.

The window is small in both cases. It is not zero, and "small" is not a
property we can rely on.

## Decision

**Send first, record handled second. We accept a rare duplicate email and
refuse a rare missing one.**

Concretely: on an ambiguous crash the `processed_event` row stays `processing`,
the message is redelivered, and `msg.fields.redelivered = true` lets the
redelivery take over the claim **regardless of lease age** — so a second
identical email goes out carrying the same still-valid code.

### Why, for a verification code specifically

Ask what each failure costs the user:

**A missing code is a terminal dead-end.** The sign-up cannot be completed. The
user was told "We Have Sent Code To Your Email" and nothing arrives. They have
no way to know whether to wait or to retry, and no retry affordance is
guaranteed to be in front of them. They are blocked, the product looks broken,
and this is *exactly* the failure the research measured — 3 of 4 users could not
find the code. It is the whole reason this story exists.

**A duplicate code is cosmetic.** Two identical emails arrive carrying the same
code. The user reads either one and completes the flow. Mild confusion, zero
blockage.

The asymmetry is extreme, and the blast radius of the duplicate is bounded by
design: a verification code lives at most ten minutes
(`VERIFICATION_CODE_TTL_SECONDS`, capped at 600 in the Joi schema), so a
duplicate can only ever duplicate something already short-lived. There is no
accumulating damage.

This is also the right default for the rest of the event catalogue — but it is
a per-event judgement, not a law. An event whose effect is *not* idempotent from
the user's point of view (charging a card, issuing a refund, reserving the last
seat) must not inherit this choice. For those, the effect itself needs an
idempotency key passed to the downstream system so the duplicate is absorbed
there, and that will be its own ADR.

### The adjacent decision: a dead code is not sent

A code that has already expired by the time `notification` handles its event is
**not emailed**. The handler records `status = 'skipped'`,
`skip_reason = 'code_expired'`, `outcome = 'skipped_expired'`, and acks.

An email containing a dead code is worse than no email: the user acts on it,
the code is rejected, and now they distrust the channel. Silence at least leaves
them to re-request. This is why `expiresAt` rides in the payload and why the
consumer checks it at *handling* time rather than trusting the message's
freshness.

## Consequences

**Bought:** a crash never silently loses a verification email. Every failure
mode is either "delivered" or "visibly skipped with a recorded reason" — there
is no outcome where the system believes it sent an email that it did not.

**Cost:**

- Users may occasionally receive two identical verification emails. Accepted, and worth saying out loud in a support runbook so it is not treated as a bug.
- `email_delivery.event_id` is deliberately **not unique** — a duplicate send is a second row, because the measurement should reflect what actually happened over the wire, not what we wished had happened.
- This choice must be revisited per event type, not inherited blindly.

**The implementation detail that makes or breaks it.** On a *transient*
failure (SMTP down, a DB write failing), the handler must explicitly release
the claim — `UPDATE processed_event SET status='failed' WHERE event_id=$1 AND
status='processing'` — **before** rethrowing. Without it, the 1-second retry
copy arrives while the 60-second lease is still fresh, the claim is refused, the
handler reports "skipped", and the email is **silently dropped on the first SMTP
blip**. That failure mode is the exact thing this ADR exists to prevent, and it
would be introduced by the most natural-looking omission in the codebase. The
lease is purely a crash net; the normal retry path releases explicitly, and
`test/unit/verification-code-issued-handler.spec.ts` asserts it.

## Alternatives considered

**Record handled before sending (at-most-once).** Rejected: turns every crash
in the window into a lost sign-up, which is the failure with the highest user
cost and the lowest observability.

**A two-phase local commit: mark `sending`, send, mark `handled`, and never
retry a `sending` row.** Rejected: it converts the ambiguous crash into a
*permanently stuck* row that a human must resolve, trading a rare duplicate for
a rare manual intervention. Worse at 3am, and it does not actually resolve the
ambiguity — nobody can tell from the row whether the SMTP server accepted the
message.

**Ask Mailpit whether the message was already sent.** Rejected: it works
against Mailpit in development and against nothing in production. Deliverability
state is not queryable in general, and designing against a dev-only capability
is how you ship a bug to production.

**An idempotency key on the SMTP send.** Rejected because SMTP has no such
concept. A transactional email provider's API often does, and if one is
introduced later this ADR should be revisited — a provider-side idempotency key
would collapse the window entirely and make the whole trade-off unnecessary.
