# Architecture decision records

One file per decision that was not obvious, including the alternatives rejected
and why. An ADR is immutable once accepted — if the decision changes, write a
new one that supersedes it rather than editing history.

| # | Decision | Status |
|---|---|---|
| [0001](0001-transactional-outbox.md) | Events are written in the business transaction, not published from it | Accepted |
| [0002](0002-relay-claims-with-skip-locked.md) | The relay claims outbox rows with `FOR UPDATE SKIP LOCKED` | Accepted |
| [0003](0003-duplicate-email-over-missing-email.md) | On an ambiguous crash, risk a duplicate email rather than a missing one | Accepted |
| [0004](0004-retry-topology-ttl-queues.md) | Delayed retries use per-attempt TTL queues, not the delayed-message plugin | Accepted |
| [0005](0005-event-envelope-versioning.md) | The envelope carries the version; an unknown version dead-letters | Accepted |
| [0006](0006-language-in-the-event-payload.md) | The account's language travels in the event payload | Accepted |
| [0007](0007-clean-architecture-feature-modules.md) | Clean architecture inside Nest feature modules | Accepted |

## Format

Context (the forces, including the ones that conflict) → Decision (what we do,
in the imperative) → Consequences (what this costs, what it buys, what it makes
impossible) → Alternatives considered (each with the reason it lost). Keep it
short enough to read before a review and specific enough to argue with.
