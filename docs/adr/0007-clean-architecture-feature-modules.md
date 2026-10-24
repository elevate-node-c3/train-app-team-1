# ADR-0007 — Clean architecture inside Nest feature modules

**Status:** Accepted · **Date:** 2026-10-24 · **Scope:** every service under `apps/`

## Context

A service in this platform has to satisfy four things at once:

1. **Be organised the way Nest is organised.** Nest's unit of encapsulation is the feature module — a cohesive slice with its own providers, its own imports and its own exports. A structure that routes around it gives up provider scoping and makes a feature something you cannot move, test or delete as a unit.
2. **Have somewhere to put an invariant.** Rules like "a verification code expires ten minutes after issuance" and "an account's language is one of two values" need a home that is not a database constraint and not a controller. That home has to be readable without reading SQL.
3. **Expose one operation over more than one transport.** The gateway reaches services over gRPC; a message handler is a second entry point; HTTP is a third. The orchestration behind an operation must be written once.
4. **Keep a transaction boundary honest.** [ADR-0001](0001-transactional-outbox.md) requires an outbox row and the business change it describes to commit together. Whatever controls that boundary must not be able to issue a write outside it.

Against that, the cost of structure is real: a four-layer feature with ports and
mappers is roughly eight files for one aggregate. Any rule we adopt has to say
when *not* to pay that.

## Decision

**A service is a root module that wires infrastructure and imports feature
modules. A feature module contains up to four layers, and dependencies only
point inward.**

```
apps/identity/src/
  main.ts                       validateEnv -> NestFactory -> gRPC -> setupApp -> listen
  identity.module.ts            root: infra imports + feature modules. NO business providers.
  database/migrations/          service-level: one migrations table per database
  shared/                       service-local helpers that two features need
  modules/
    accounts/
      accounts.module.ts        the feature's own providers, port bindings and exports
      domain/                   entities, value objects, domain errors. ZERO framework imports.
      application/
        ports/                  interfaces + DI tokens for everything outside
        use-cases/              one class per operation, orchestration only
      infrastructure/
        persistence/            ORM entities, mappers, repository adapters
        messaging/              publisher/consumer adapters
      presentation/
        grpc/                   gRPC controllers + mappers
        http/                   HTTP controllers + request/response DTOs
```

### The dependency rule

```
presentation ─┐
              ├─> application ──> domain
infrastructure┘
```

`domain` imports nothing. `application` imports `domain` and its own `ports`.
`infrastructure` and `presentation` may import `application` and `domain`.
**`presentation` must not import `infrastructure`** — a controller reaches a
database only through a port, which is what keeps the use-case the single entry
point to a feature.

Enforced by `test/unit/clean-architecture-boundaries.spec.ts`, not by good
intentions.

### Ports and adapters for persistence and external I/O

`application/ports/` declares an interface and a token per outbound dependency;
the feature module binds the adapter:

```ts
// application/ports/account.repository.port.ts
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
export interface AccountRepositoryPort {
  save(ctx: TransactionContext, account: Account): Promise<void>;
  findByEmail(email: Email): Promise<Account | null>;
}

// accounts.module.ts
providers: [
  SignUpUseCase,
  { provide: ACCOUNT_REPOSITORY, useClass: TypeOrmAccountRepository },
]
```

The benefit claimed here is **not** swappability — there will probably never be
a second `AccountRepositoryPort`. It is that a use-case becomes testable with a
hand-written fake object literal, with no container, no database and no mocking
framework.

**Ports are for crossings**: persistence, the broker, SMTP, an outbound HTTP
call — anything that leaves the process. Not for every collaborator. A pure
function stays a pure function: `hashVerificationCode()` does not need an
interface. Judge by "would I have to stub this to test the rule?", not by "is
this a dependency?".

### Transactions without leaking the ORM

A use-case controls a transaction boundary while knowing nothing about TypeORM.
`UnitOfWorkPort` carries an **opaque** `TransactionContext` that only an
infrastructure adapter can open or unwrap:

```ts
// application/use-cases/sign-up.use-case.ts
await this.unitOfWork.withTransaction(async (ctx) => {
  await this.accounts.save(ctx, account);
  await this.codes.save(ctx, code);
  await this.outbox.append(ctx, event);     // same ctx => same transaction
});
```

[unit-of-work.port.ts](../../libs/common/src/persistence/unit-of-work.port.ts)
imports nothing, so the application layer can depend on it;
[typeorm-unit-of-work.ts](../../libs/common/src/persistence/typeorm-unit-of-work.ts)
holds the `EntityManager` and is the only thing that can get it back out. A
use-case therefore **cannot** run a query outside the transaction it was given,
because it has no way to reach a connection. That is what makes ADR-0001's
guarantee structural rather than conventional.

A port method that must join the caller's transaction takes the context as a
**parameter** and never opens its own.

### Domain model separate from ORM entity

`domain/account.ts` is a plain class with behaviour and invariants and no
decorators. `infrastructure/persistence/account.orm-entity.ts` carries
`@Entity`/`@Column`. A mapper converts at the boundary, and a port returns
domain objects, never ORM entities. The domain is unit-testable without
TypeORM, the hand-written migrations stay authoritative, and an aggregate's
shape is decided by the business rule rather than by what the ORM can persist.

### Transports

**The gateway is the only HTTP surface; services expose gRPC**, plus the HTTP
`/health` endpoints `@app/common` provides. That matches the compose rule that
only `gateway` publishes a port.

Each controller is a thin adapter over a use-case, so the second transport is
one file that builds a command and calls the same use-case. A controller's
filename says its transport: `accounts.grpc.controller.ts` →
`AccountsGrpcController`.

### Layers appear when there is something to put in them

**A feature module does not need all four folders.** `modules/service-info/` is
an application service and a controller — it answers a constant, so it has no
`domain/`, no ports and no `infrastructure/`. An empty `domain/` holding a
"ServiceInfo entity" would be cargo cult.

The rule: **add a layer when you have a second reason to.** A feature with a
real invariant earns `domain/`. A feature that touches the database earns
`ports/` and `infrastructure/`. Nothing earns a folder for looking
symmetrical.

### Where `@app/common` may be imported

`application/` may import `@nestjs/common` and nothing else from the framework,
and `@app/common` **only by subpath**. The `@app/common` barrel re-exports
TypeORM-aware modules, so a bare import drags the ORM into the application
layer by transitivity. `@app/contracts` is permitted everywhere, including
`domain/`, because it is pure shapes by charter — no logic, no DI, no I/O.

## Consequences

**Bought:**

- Features are movable, deletable and independently testable units, with Nest's module system doing the encapsulation.
- Use-cases are testable with fakes implementing a port — no `@nestjs/testing`, no database, no mocking framework. This is the biggest practical win, and it is why the messaging story's tests can be both fast and honest.
- The domain layer cannot import TypeORM, so business rules stay readable.
- A second transport is a new file in `presentation/`.
- The dependency rule is a failing test, so it survives contributor turnover.

**Cost:**

- More files per feature: roughly domain class, ORM entity, mapper, port, adapter, use-case, controller, DTO for one aggregate. The "layers appear when needed" rule is what keeps trivial features from being charged for it.
- A mapper per aggregate, and mappers are boring code that must track two shapes. Mitigated by the migration/entity-column test in the plan.
- Indirection: finding a port's implementation is one hop. Naming carries the weight — `AccountRepositoryPort` ↔ `TypeOrmAccountRepository`.
- `application/` is allowed to import `@nestjs/common` for `@Injectable()`/`@Inject()`. Strict clean architecture forbids any framework import in the application layer; requiring manual factory providers for every use-case is real friction for decorators that carry no behaviour. **This is a named, deliberate concession** — the guard test permits exactly `@nestjs/common` and nothing else from the framework.

## Alternatives considered

**Full hexagonal — ports for everything including the clock, id generator and
hasher.** Rejected as the default: the testability gain over passing a value in
as part of the command is small, and the indirection cost is paid in every
file. A use-case takes `now: Date` on its command rather than injecting a
`ClockPort`. Where a crossing is genuinely non-deterministic *and* needs
stubbing in more than one test, a port is still the answer.

**DDD tactical patterns throughout — aggregates, domain events raised by
entities and dispatched after commit.** Partially adopted: aggregates and a
separate domain model are in; domain events are **recorded** as outbox rows by
the use-case rather than raised by an entity and collected by an interceptor.
Entity-raised events need a dispatcher and a collection pass, whereas a
use-case writing the outbox row is explicit, visible in one function, and
directly expresses the ADR-0001 guarantee. Revisit if one use-case starts
emitting several events from nested aggregates.

**One shared `domain/` per service, with feature modules only for
presentation.** Rejected: a shared domain folder becomes a dumping ground and
features stop being independently deletable — the coupling just moves up one
level.

**Anemic entities with all logic in use-cases.** Rejected: it is quicker and it
makes "clean" purely a folder layout. Invariants that live in a use-case cannot
be enforced by the type system, so nothing stops a second caller constructing
an invalid aggregate.

**CQRS with `@nestjs/cqrs` command and query buses.** Rejected: it adds a
dispatch indirection and a package for a benefit — decoupling caller from
handler — that a controller injecting a use-case class already has. Worth
revisiting if we need middleware across all commands (audit, retry,
transaction management), which is the real reason to adopt a bus.

**Layering by folder convention with no ports or guard test.** Rejected: the
dependency rule then holds exactly as long as everyone remembers it, and the
domain picks up a transitive TypeORM import the first time someone is in a
hurry.
