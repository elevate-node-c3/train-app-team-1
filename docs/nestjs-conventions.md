# NestJS conventions

How Nest is used *in this repo*. Where a generic best practice and this repo's
existing shape disagree, the repo wins — consistency is worth more than
following a blog post. If you think a convention here is wrong, change it
everywhere in one commit and write an [ADR](adr/), don't fork the style.

## 1. The monorepo

Nest CLI monorepo mode: `nest-cli.json` declares every project, one root
`package.json` serves all of them, and there is exactly one `node_modules`.

```jsonc
{
  "monorepo": true,
  "root": "apps/gateway",              // the default project for `nest build` / `nest start`
  "compilerOptions": { "webpack": false }   // tsc, because the workspace is ESM
}
```

Build one service: `npx nest build identity`. Note `deleteOutDir: true` means
`dist/` holds **one** app at a time — building `notification` erases
`dist/apps/identity`.

Each project carries its own `tsconfig.app.json` / `tsconfig.lib.json`
extending the root with `"rootDir": "../.."` and `"outDir": "../../dist"`. That
is why the compiled entry point is `dist/apps/<app>/src/main.js`, which the
`Dockerfile` and `start:prod` both depend on. Do not "tidy" those paths.

### Applications vs libraries

An **application** has a `main.ts` and is a deployable service. A **library**
has no `main.ts`, is imported through a `@app/*` alias, and must work inside
all seven applications. Adding either means registering it in `nest-cli.json`,
adding its `tsconfig`, adding the alias to the root `tsconfig.json` — and for an
app, a `docker-compose.yml` service and a database in
`docker/postgres/init/01-create-databases.sh`. `test/skeleton/` will tell you
what you forgot.

## 2. Module layout

Two kinds of module. See
[ADR-0007](adr/0007-clean-architecture-feature-modules.md) for why.

**The root module** at `apps/<svc>/src/<svc>.module.ts` wires infrastructure and
imports feature modules. It declares **no controllers and no business
providers**:

```ts
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
    ServiceInfoModule,
    AccountsModule,
  ],
})
export class IdentityModule {}
```

Keep all four infrastructure imports even if a service does not use one yet —
the uniformity is what lets `test/skeleton/apps.spec.ts` treat the seven
services as interchangeable, and it means adding messaging to a service later is
a provider change, not a module change.

**A feature module** at `modules/<feature>/<feature>.module.ts` owns one
cohesive slice: its controllers, its use-cases, its port bindings, and whatever
it chooses to export. It declares **its own** imports rather than relying on the
root module having happened to import them —
`apps/gateway/src/modules/health-aggregation/health-aggregation.module.ts`
imports `CommonModule` for itself.

A feature is the unit you can move, test or delete. If two features need the
same helper, it goes in `apps/<svc>/src/shared/`; if two *services* need it, it
goes in `libs/`.

## 3. The four layers

```
apps/<svc>/src/modules/<feature>/
  <feature>.module.ts    wiring: providers, port bindings, exports
  domain/                entities, value objects, invariants   <- imports NOTHING
  application/
    ports/               interface + Symbol token per crossing
    use-cases/           one class per operation
  infrastructure/        ORM entities, mappers, adapters       <- implements the ports
  presentation/
    grpc/                gRPC controllers
    http/                HTTP controllers + DTOs
```

The dependency rule, enforced by
`test/unit/clean-architecture-boundaries.spec.ts`:

```
presentation ─┐
              ├─> application ──> domain
infrastructure┘
```

- **`domain/`** holds business rules and nothing else — a plain class with a private constructor, named factories (`Account.register(...)`), and methods that enforce invariants. **No decorators, no `@nestjs/*`, no TypeORM.** `@app/contracts` is allowed because it is pure shapes by charter. The payoff: you can unit-test an invariant with `new`, no container and no database.
- **`application/`** orchestrates. A use-case loads through ports, calls domain methods, persists through ports, and returns a plain result. It may import `@nestjs/common` for `@Injectable()`/`@Inject()` — a deliberate, named concession — and **nothing else from the framework**. `@app/common` only **by subpath**: the barrel re-exports TypeORM-aware modules and would drag the ORM in by transitivity.
- **`infrastructure/`** is where technology lives: `@Entity` classes, mappers, TypeORM repositories, AMQP publishers, SMTP clients. It implements the ports and may import anything.
- **`presentation/`** parses and validates input, calls **one** use-case, returns a plain object. The global `ResponseInterceptor` wraps it in `ApiResponse`; don't build that envelope by hand. DTOs are `class-validator`-decorated classes in `presentation/http/dto/` — the global `ValidationPipe` runs `whitelist: true, forbidNonWhitelisted: true`, so an undeclared property is a 400, not silently dropped. **Must not import `infrastructure/`.**

### Layers appear when there is something to put in them

`modules/service-info/` is an application service and a controller. It has no
`domain/` and no ports, because it answers a constant. Adding an empty layer for
symmetry is cargo cult. **Add a layer when you have a second reason to**: a real
invariant earns `domain/`; touching the database earns `ports/` and
`infrastructure/`.

### Transports

The gateway is the only HTTP surface; services expose gRPC, plus the HTTP
`/health` endpoints that `@app/common` provides. Each controller is a thin
adapter over a use-case, so adding the second transport is one file that builds
a command and calls the same use-case — no orchestration is duplicated.

A controller's filename says its transport:
`accounts.grpc.controller.ts` → `AccountsGrpcController`.

## 4. Dependency injection

**Ports for crossings, concrete classes for everything else.**

A *crossing* is anything leaving the process: persistence, the broker, SMTP, an
HTTP call. Those get an interface and a token in `application/ports/`, bound by
the feature module:

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

// application/use-cases/sign-up.use-case.ts
constructor(
  @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
) {}
```

The point is not swappability — it is that the use-case becomes testable with a
hand-written fake implementing the interface, with no `@nestjs/testing`, no
database and no mocking framework.

**Do not port everything.** A pure function stays a pure function:
`hashVerificationCode()` needs no interface. A value that merely varies —
`now`, a generated id — is better passed in as part of the command than
injected behind a `ClockPort`.

Other rules:

- **`@Optional()` for genuinely absent dependencies.** [libs/common/src/health/health.service.ts](../libs/common/src/health/health.service.ts) injects `@Optional() dataSource?: DataSource` so the same health service works in a service with no database. Use it for "this may not be configured", not to paper over a wiring mistake.
- **Constructors must be I/O-free.** `test/skeleton/apps.spec.ts` instantiates every provider in all seven modules. A constructor that connects to Postgres makes `npm test` require Docker. Connect in a lifecycle hook.

### Transactions across several ports

A use-case must be able to put two writes in one transaction (ADR-0001: the
outbox row commits with the business change) without knowing TypeORM exists.
`UnitOfWorkPort` carries an **opaque** `TransactionContext`:

```ts
await this.unitOfWork.withTransaction(async (ctx) => {
  await this.accounts.save(ctx, account);
  await this.codes.save(ctx, code);
  await this.outbox.append(ctx, event);     // same ctx => same transaction
});
```

Only an infrastructure adapter can unwrap the context
([libs/common/src/persistence/typeorm-unit-of-work.ts](../libs/common/src/persistence/typeorm-unit-of-work.ts)
holds the `EntityManager`), so a use-case cannot accidentally run a query
outside the transaction it was given. **A repository takes the context as a
parameter and never opens its own transaction** — that rule is what makes the
outbox guarantee structural rather than conventional.

### Domain model and ORM entity are different classes

`domain/account.ts` is a plain class with behaviour.
`infrastructure/persistence/account.orm-entity.ts` carries `@Entity`/`@Column`.
`account.mapper.ts` converts. Costs a mapper per aggregate; buys a domain that
is shaped by the business rule rather than by what the ORM can persist, and
testable without importing TypeORM.

### Lifecycle hooks, and which one

| Hook | Use for |
|---|---|
| `onModuleInit` | Acquire a resource the module owns (the AMQP connection). Must tolerate failure — see §6. |
| `onApplicationBootstrap` | Work that needs *other* modules ready: running migrations, asserting AMQP topology, starting consumers and the relay. |
| `onModuleDestroy` | First shutdown hook: flip the drain flag so readiness fails and new traffic is refused. Do **not** close a shared resource here. |
| `beforeApplicationShutdown` | Stop accepting new work and **drain** what is in flight: cancel consumer tags, await outstanding handlers, await the relay loop. The AMQP channel is still open. |
| `onApplicationShutdown` | Last shutdown hook: close the resource acquired in `onModuleInit` (the AMQP connection and channels), after `dispose()` and after the drain. |

Nest fires them in this order:

```
onModuleDestroy -> beforeApplicationShutdown -> dispose() -> onApplicationShutdown
```

`setupApp()` already calls `app.enableShutdownHooks()`, so these fire on
SIGTERM. The order is why `GracefulShutdownService` flips its flag in
`onModuleDestroy`, the relay and consumer drain in `beforeApplicationShutdown`,
and `AmqpClientService` closes in `onApplicationShutdown`: closing the channel
in an earlier hook would make every in-flight ack fail and turn a clean deploy
into duplicate emails.

## 5. Bootstrap

`main.ts` does five things in this order, and nothing else:

```ts
validateEnv(identityEnvSchema, process.env, 'identity');   // 1. fail fast, before Nest (§2.1)

async function bootstrap() {
  const app = await NestFactory.create(IdentityModule, { bufferLogs: true });
  app.connectMicroservice<MicroserviceOptions>({ /* gRPC */ });   // 2
  await app.startAllMicroservices();                              // 3
  setupApp(app);                                                  // 4
  await app.listen(process.env.PORT ?? 3000);                      // 5
}

bootstrap().catch((error: unknown) => {
  console.error('identity failed to start', error);
  process.exit(1);
});
```

`validateEnv` runs at module top level — before `NestFactory`, so a
misconfigured service dies with a readable message instead of a stack trace from
inside a provider. `bufferLogs: true` holds early logs until pino is installed
by `setupApp`.

**Globals belong in `setupApp()`**
([libs/common/src/setup.ts](../libs/common/src/setup.ts)), never in one app's
`main.ts`: the pino logger, `ValidationPipe`, `ResponseInterceptor`,
`HttpExceptionFilter`, shutdown hooks. Adding a global in one service only is a
bug — seven services must behave identically at the edge.

## 6. Degrade, don't crash

The deliberate posture: a missing or broken dependency makes a service
*degraded and honest*, not dead.

- `AmqpClientService.onModuleInit` swallows a connection failure and lets `checkHealth()` report the truth.
- `manualInitialization: true` keeps TypeORM from connecting at boot, so Postgres being down does not cause a crash loop.
- `/health`, `/health/live`, `/health/ready` are the contract. `live` means the process is up; `ready` means it can serve.

A boot-time failure that *should* kill the process: invalid configuration. Those
are unrecoverable and silent failure is worse.

So: a background loop (relay, consumer) catches per-tick errors, logs them, and
retries on the next tick. It never lets a rejection escape to `unhandledRejection`.

## 7. Configuration

Joi schemas in
[libs/common/src/config/env.schema.ts](../libs/common/src/config/env.schema.ts),
composed from `commonEnvSchema` with `.keys({...})` per service. Error messages
are spelled out explicitly so a misconfiguration reads as a sentence, not a Joi
path. Secret-looking values are redacted via `SECRET_KEYS`.

There is **no `ConfigService`**. Read `process.env` directly, and remember that
`validateEnv()` discards the coerced result — so a Joi `.default()` never
reaches the process. Keep a code-side constant beside each default and a test
asserting the two match.

Four edits per new variable: Joi schema, `.env.example` (commented with *why*),
`docker-compose.yml` as `${VAR:-default}`, and `SECRET_KEYS` if secret.

Encode invariants in the schema where you can — `VERIFICATION_CODE_TTL_SECONDS`
has `.max(600)` so the "a code must die within ten minutes" rule is enforced by
configuration rather than by hoping nobody raises it.

## 8. Errors and responses

Every HTTP response is `ApiResponse<T>` from `@app/contracts`:

```ts
{ success, data, message, error, correlationId, timestamp }
```

built by the global `ResponseInterceptor`. A handler returns its payload; the
interceptor wraps it. To control the message, return the opt-out marker
`{ __envelope: true, data, message }`.

Errors go through `HttpExceptionFilter` (`@Catch()`, catch-all): it maps status →
`ErrorCode`, localises via the message catalogue, and never leaks a stack trace.
Throw Nest's built-in exceptions for transport-level problems
(`BadRequestException`, `ConflictException`). For a domain rule, define a named
exception class in the owning service and let the filter map it — a named class
is greppable and a boolean return is not.

Messages are bilingual (`ar` default, BR-56) via
[libs/common/src/envelope/catalogue.ts](../libs/common/src/envelope/catalogue.ts).
Add a key there rather than inlining a string.

## 9. Correlation

`x-correlation-id` on the wire, `correlationId` in CLS
(`nestjs-cls`). `CorrelationMiddleware` mints a fresh id at the gateway and
trusts the inbound header everywhere else, so one request id spans the whole
call graph and appears on every log line.

Crossing a boundary means carrying it: `createGrpcMetadataWithCorrelation(cls)`
for gRPC, `injectCorrelationId()` / `extractCorrelationId()`
([libs/messaging/src/amqp-headers.ts](../libs/messaging/src/amqp-headers.ts)) for
AMQP. An event's envelope carries `correlationId` as a first-class field — an
async flow is exactly where you most need to trace a request, and exactly where
CLS does not reach on its own.

## 10. Testing

**Vitest, not Jest** (`globals: true`, so `describe`/`it`/`expect` are ambient;
use `vi`, never `jest`), and **centralised under `test/` — never colocated
beside the source**. Three homes:

- `test/unit/*.spec.ts` — pure, hand-rolled mocks, no Docker, no network.
- `test/skeleton/*.spec.ts` — the architecture guards (`apps.spec.ts`, `compose.spec.ts`, `lib-imports.spec.ts`, `architecture-boundaries.spec.ts`, `clean-architecture-boundaries.spec.ts`).
- `test/e2e/*.e2e-spec.ts` — shells out to `docker compose` via `execFileSync`. No testcontainers.

`describe` titles cite the requirement they pin, so a reviewer can trace a test
to the spec: `describe('Envelope & i18n Translation System (BR-56, BR-57, D14, §2.4)')`.

Files under `test/` are the one place relative imports carry an explicit `.ts`
rather than `.js` (see `test/skeleton/apps.spec.ts:3`), because vitest resolves
TypeScript directly.

What matters for Nest specifically:

- Prefer testing a use-case or a pure function **without** Nest. Hand-roll the collaborators — a port is an interface, so a fake is an object literal. A `Test.createTestingModule` is for verifying *wiring*, which `test/skeleton/apps.spec.ts` already does for every module.
- Test behaviour at the seam, not implementation detail — but where a safety property *is* a specific mechanism, assert the mechanism. "The claim SQL contains `FOR UPDATE SKIP LOCKED`" is a legitimate assertion: the whole correctness argument rests on that clause, and a refactor that drops it must fail.
- Assert the *absence* of things too. "The sign-up use-case injects no publisher" is how the dual-write bug stays structurally impossible. "`apps/identity` imports no SMTP anything" is how producer/consumer decoupling stays true.
