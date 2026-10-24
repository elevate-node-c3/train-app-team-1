# ADR-0006 — The account's language travels in the event payload

**Status:** Accepted · **Date:** 2026-10-24 · **Relates to:** BR-56, BR-53, BR-03

## Context

BR-56 requires the verification email to be rendered in **the language stored on
the account**. Today language resolution in this platform is entirely
request-scoped: `resolveLanguage()` in
[libs/common/src/envelope/catalogue.ts](../../libs/common/src/envelope/catalogue.ts)
reads `Accept-Language` off the inbound HTTP request and defaults to Arabic.

That mechanism does not reach `notification`. By the time the email is rendered,
the HTTP request is long gone — the response went back to the client before the
event was even published. **There is no request to read the language from.** It
has to come from the event itself, or from `notification` holding its own copy
of the account.

A second force pulls in the same direction: the verification **code** must also
travel in the event, because `notification` needs it for the email body and
`identity` stores only the code's hash. So the payload already carries something
sensitive and short-lived, which shapes what else belongs there.

## Decision

**`language` is a required field in the `verification_code_issued` payload,
alongside `code`, `email` and `expiresAt`.**

```ts
interface VerificationCodeIssuedPayloadV1 {
  accountId: string;
  /** Needed by notification to address the mail; never persisted by it. */
  email: string;
  /** Plaintext. identity stores only a scrypt hash. Redacted from every log. */
  code: string;
  purpose: VerificationCodePurpose;
  /** The account's language. Rides in the payload because there is no HTTP
   *  request on the consumer side to read Accept-Language from (BR-56). */
  language: EventLanguage;
  /** ISO-8601 UTC. Start of the BR-03 latency measurement. */
  issuedAt: string;
  /** ISO-8601 UTC. The consumer must not send mail after this instant. */
  expiresAt: string;
}
```

The guiding principle: **an event carries everything a consumer needs to act on
it.** A consumer that has to call back to the producer to render a message is
not decoupled — it is coupled with extra latency and a new failure mode, and it
breaks the "producers do not know their consumers" property from the other
direction.

An unknown language value coerces to `'ar'` rather than throwing
([ADR-0005](0005-event-envelope-versioning.md)): BR-56 already defines Arabic as
the fallback, and dead-lettering a real sign-up over an unsupported locale
string would be a worse outcome than sending Arabic.

### What this means for the code, which is the sensitive part

The payload carries a live secret, so the rules around it are explicit:

- `identity` stores **only** the scrypt hash plus a per-row salt. Never the plaintext.
- `notification` **never persists** the code — there is deliberately no column anywhere in its schema that could hold one (BR-53: codes are email-only and never go in the inbox).
- Neither service logs it. pino redacts `code` and `verificationCode` **as object keys**, which means nothing protects a code interpolated into a message string — so `last_error`, `x-death-error` and SMTP error messages must never contain the payload. `test/unit/event-consumer.spec.ts` asserts no DLQ or retry header contains it.
- A code left in a dead-lettered message **stops working within 10 minutes**, enforced by `VERIFICATION_CODE_TTL_SECONDS` having `.max(600)` in the Joi schema. The rule is enforced by configuration, not by hoping nobody raises the value.
- `expiresAt` travels with it so the consumer can refuse to send a dead code without consulting anyone.

### `issuedAt` is also load-bearing

It is stamped by `identity` **inside the sign-up transaction**, at the moment the
code is created — so BR-03's clock starts at issuance, not at publish. The
relay's own delay is therefore *inside* the measurement rather than hidden before
it, which is the honest way to report against a 30-second promise.

## Consequences

**Bought:** `notification` renders the email from the event alone — no callback
to `identity`, no gRPC dependency, no added latency, and no new failure mode
where a healthy consumer cannot send an email because the producer is down. The
event is self-contained, which is what makes it replayable.

**Cost:**

- The payload carries PII (an email address) and a secret (the code) over the broker and into the outbox table. Mitigated by the rules above, and bounded by the ten-minute expiry.
- A stale language: if a user changes their language *after* the event is published but before it is handled, the email uses the old value. For a window measured in hundreds of milliseconds, against a verification email, this is not worth solving.
- `language` is required, so `identity` must have an account language to send. The `account` table has it with a `'ar'` default and a `CHECK` constraint, so there is always a valid value.

## Alternatives considered

**`notification` keeps its own copy of the account** (its own `account`
projection, fed by an `account_registered` event). The textbook answer, and
genuinely better at scale — it is how the catalogue should work once several
events need account attributes. Rejected *now* for ordering: the projection would
have to be populated by an event published in the same transaction as the one
that needs it, so `notification` could receive the verification event before the
account projection arrives and would have nothing to read. Solving that needs
either ordering guarantees or a wait-and-retry, both of which are more machinery
than this story should introduce. Revisit when a second consumer needs account
data.

**`notification` calls `identity` over gRPC to fetch the language.** Rejected:
it reintroduces the coupling the backbone exists to remove, makes email delivery
depend on `identity` being up, adds a round trip to the BR-03 budget, and makes
a replayed event dependent on the account still existing in its original state.

**Read `Accept-Language` at the gateway and pass it through.** Rejected: BR-56
says *the language stored on the account*, not the language of the browser that
happened to submit the form. A user who signs up from a borrowed English browser
should still get their chosen language.

**Default everything to Arabic and skip the field.** Rejected: it fails BR-56
for every non-Arabic user, which is most of the point of having a bilingual
catalogue.

**Send only the code's id and have `notification` fetch the code.** Rejected:
`identity` does not store the plaintext (deliberately, so a database leak does
not leak usable codes), so there is nothing to fetch. The code crosses the wire
exactly once, in this event, or it does not exist outside the user's inbox.
