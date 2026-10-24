# Documentation

| Document | Read it when |
|---|---|
| [nestjs-conventions.md](nestjs-conventions.md) | **Before your first edit**, and whenever you add a module, provider, controller, repository or lifecycle hook. How Nest is used *here*, plus the repo-specific traps: ESM `.js` imports, `manualInitialization`, Joi-without-`ConfigService`, the guard test suites. |
| [clean-code.md](clean-code.md) | Naming, function shape, error classes, comments, secrets, concurrency. Rules with a stated cost for breaking them. |
| [design-patterns.md](design-patterns.md) | Working on anything that publishes or consumes an event. Each pattern: the problem, the mechanism, where it lives, how it fails. |
| [runbook-messaging.md](runbook-messaging.md) | Operating the backbone — inspect the outbox, read and replay the DLQ, measure BR-03 latency, run the three review demos. |
| [adr/](adr/) | Why a decision was made, and what was rejected. Read before proposing to change one. |

For the platform overview, services table and getting-started steps, see the
root [README.md](../README.md). For the verification evidence and reviewer
demos of the skeleton, see [walkthrough.md](../walkthrough.md).
