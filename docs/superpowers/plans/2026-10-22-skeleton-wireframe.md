# Skeleton Wireframe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn this repo into a Nest monorepo rooted at the repo root, holding seven empty service apps and three shared libs, that a reviewer can bring up in full with one `docker compose up`.

**Architecture:** The existing `train-app-server/` Nest workspace is flattened into the repo root, its two scaffold apps deleted, and seven empty service apps plus three Nest libraries registered in their place. One parameterized multi-stage `Dockerfile` builds any app by name; `docker-compose.yml` runs four infra containers with healthchecks and the seven services gated behind them, publishing only the gateway.

**Tech Stack:** NestJS 12 (monorepo mode, ESM, webpack build), TypeScript 6, vitest 4, oxlint, npm. Docker Compose with Postgres 17, Redis 8, RabbitMQ 4 (management), Mailpit.

**Spec:** No separate design document — this was sized as a small change and agreed in chat. The agreement is reproduced in full under "Spec Summary" below; executors read that section as the spec.

---

## Spec Summary

Part 1 of a two-part effort. Part 1 is the repo wireframe only. Part 2 (the event-driven messaging backbone: transactional outbox, relay, idempotent consumers, dead-lettering) is a separate story and is **out of scope here**.

1. **Flatten.** Everything inside `train-app-server/` moves up to the repo root via `git mv` so history survives; the folder is then deleted. The root becomes the Nest workspace root.
2. **Seven apps**, replacing `train-app-server` and `my-app` entirely: `catalog`, `gateway`, `identity`, `inventory`, `booking`, `payment`, `notification`. Each boots, listens on `PORT`, and exposes nothing. No health endpoint, no config validation, no response envelope, no logging shape, no graceful-shutdown wiring — the skeleton must *accommodate* those, but they belong to the next story.
3. **Three libs** registered as Nest libraries with path aliases: `@app/contracts`, `@app/messaging`, `@app/common`. Empty modules with index barrels, so the import paths are real.
4. **Four infra containers** with real healthchecks: Postgres 17, Redis 8, RabbitMQ 4 with management, Mailpit.
5. **One database per service** — one Postgres container, seven databases created by an init script, each service holding credentials for its own only.
6. **Seven service containers** from one multi-stage `Dockerfile` with an `APP` build arg (not seven near-identical Dockerfiles), each `depends_on` its infra with `condition: service_healthy`.
7. **Only the gateway is reachable from outside the Compose network.** RabbitMQ management and Mailpit's web inbox also publish, because the project's demos require looking at them.
8. **Root `.env.example`, `.dockerignore`, and a README** whose instructions are literally clone → `docker compose up`.

### Decisions left to the builder, settled here

- Each app's module file is `src/<service>.module.ts` exporting `<Service>Module`, matching the existing generated convention (`my-app.module.ts`), rather than seven identically-named `app.module.ts` files.
- All seven services get a database and a uniform `depends_on` on Postgres, Redis and RabbitMQ, even though the gateway has no persistence need yet. Uniformity matches the spec's "each one boots … the same way"; trimming the gateway's dependencies is a later refinement, not a wireframe concern.
- Every service listens on container port 3000. Only the gateway maps to a host port.

## Global Constraints

- Node 24 (`@types/node` is `^24`); all images pinned to a major tag, never `latest`.
- The workspace is ESM: `package.json` has `"type": "module"`, `tsconfig` uses `module: nodenext`. Do not introduce CommonJS `require`.
- `nest-cli.json` keeps `"monorepo": true` and `"webpack": true`.
- The seven service names, spelled exactly and used identically in `nest-cli.json`, `docker-compose.yml`, and directory names: `catalog`, `gateway`, `identity`, `inventory`, `booking`, `payment`, `notification`.
- Lib aliases, spelled exactly: `@app/contracts`, `@app/messaging`, `@app/common`.
- No health endpoints, config validation, envelope, or logging in part 1.
- Shell scripts and SQL that run inside Linux containers must be committed with LF endings — this repo is developed on Windows.

## Review Focus

1. **CRLF in container-executed files.** A Postgres init script committed with CRLF fails inside the Linux container. Pinned by the `.gitattributes` test in Task 5.
2. **Service-name drift** between `nest-cli.json`, `docker-compose.yml`, and the `APP` build arg — a typo yields a container that builds then crashes on a missing entry file. Pinned by the cross-reference test in Task 6.
3. **ESM + webpack build output.** `nest build` under `"type": "module"` can emit output Node refuses to run, and the container exits immediately with no useful log. Pinned by the real `node dist/...` smoke test in Task 4.
4. **Postgres init scripts run only against an empty data volume.** A reviewer who ran compose before a service was added silently has no database for it. Pinned by the README's documented reset step in Task 7 and asserted in Task 5's test.
5. **Host port collisions** on 3000 / 15672 / 8025 make `compose up` fail confusingly. Pinned by sourcing every published port from an `.env` variable in Task 6, so a reviewer can change them without editing compose.

---

### Task 1: Flatten the workspace into the repo root

**Files:**
- Move (via `git mv`): every tracked file under `train-app-server/` to the repo root
- Modify: `package.json` (scripts), `.gitignore` (merge), `README.md` (keep root's title)
- Delete: `train-app-server/` directory

**Interfaces:**
- Consumes: nothing
- Produces: a Nest workspace rooted at the repo root — `nest-cli.json`, `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `.prettierrc`, `.oxlintrc.json`, `apps/` all directly at the root. Every later task's paths are relative to this root.

- [ ] **Step 1: Move the tracked files up, preserving history**

Use `git mv` per entry (not `mv`), so Git records renames. Move `.gitignore`, `.oxlintrc.json`, `.prettierrc`, `nest-cli.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `vitest.config.e2e.ts`, `apps/`. The inner `train-app-server/README.md` is the stock Nest boilerplate — delete it rather than move it; the root `README.md` (containing `# train-app-team-1`) stays and is rewritten in Task 7.

Move the untracked `node_modules/` with a plain `mv` so the install is not repeated.

- [ ] **Step 2: Confirm the folder is gone and nothing was left behind**

Run: `git status --short && ls train-app-server`
Expected: rename entries only (no deletions of files that should have moved), and `ls` reports the directory does not exist.

- [ ] **Step 3: Fix the three root-relative scripts in `package.json`**

Three scripts assume the old layout or are corrupt:
- `lint`: `oxlint --type-aware src/ test/` → `oxlint --type-aware apps/ libs/`
- `test:e2e`: currently the corrupted `viapps/train-app-server/test run --config ./vitest.config.e2e.ts` → `vitest run --config ./vitest.config.e2e.ts`
- `start:prod`: `node dist/apps/train-app-server/main` → `node dist/apps/gateway/main`

Leave `build`, `start`, `start:dev`, `start:debug`, `format`, `test`, `test:watch`, `test:cov`, `test:debug` untouched.

- [ ] **Step 4: Verify the workspace still runs from the root**

Run: `npm test`
Expected: PASS — 2 tests, 0 failures (the two scaffold-app specs, still present; Task 2 removes them).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: flatten train-app-server workspace into repo root"
```

---

### Task 2: Replace the two scaffold apps with the seven service apps

Removal and creation are one task: deleting both apps alone leaves `nest-cli.json`'s `root` pointing at nothing, which is not independently testable.

**Files:**
- Delete: `apps/my-app/`, `apps/train-app-server/`
- Create (per service in `catalog`, `gateway`, `identity`, `inventory`, `booking`, `payment`, `notification`): `apps/<service>/src/main.ts`, `apps/<service>/src/<service>.module.ts`, `apps/<service>/tsconfig.app.json`
- Modify: `nest-cli.json` (replace both `projects` entries, repoint `root` and `sourceRoot`)
- Test: `test/skeleton/apps.spec.ts`

**Interfaces:**
- Consumes: the flattened root from Task 1.
- Produces: seven exported module classes — `CatalogModule`, `GatewayModule`, `IdentityModule`, `InventoryModule`, `BookingModule`, `PaymentModule`, `NotificationModule`, each in `apps/<service>/src/<service>.module.ts`. Build output lands at `dist/apps/<service>/main`, which Task 4's Dockerfile `CMD` depends on.

- [ ] **Step 1: Write the failing test**

`test/skeleton/apps.spec.ts` — one parameterized suite rather than seven near-copies:

```ts
import { readFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';

const SERVICES = [
  'catalog', 'gateway', 'identity', 'inventory', 'booking', 'payment', 'notification',
] as const;

const nestCli = JSON.parse(readFileSync('nest-cli.json', 'utf8'));

describe('service apps', () => {
  it('registers exactly the seven services as applications', () => {
    const apps = Object.entries(nestCli.projects)
      .filter(([, p]: [string, any]) => p.type === 'application')
      .map(([name]) => name);
    expect(apps.sort()).toEqual([...SERVICES].sort());
  });

  it('points the default project at the gateway', () => {
    expect(nestCli.root).toBe('apps/gateway');
    expect(nestCli.sourceRoot).toBe('apps/gateway/src');
  });

  it.each(SERVICES)('%s has a module that compiles on its own', async (service) => {
    const pascal = service[0].toUpperCase() + service.slice(1);
    const mod = await import(`../../apps/${service}/src/${service}.module.ts`);
    const moduleClass = mod[`${pascal}Module`];
    expect(moduleClass).toBeDefined();
    await expect(Test.createTestingModule({ imports: [moduleClass] }).compile())
      .resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skeleton/apps.spec.ts`
Expected: FAIL — the `projects` assertion reports `['my-app', 'train-app-server']`, and each `it.each` case fails on an unresolvable import.

- [ ] **Step 3: Delete both scaffold apps**

Remove `apps/my-app/` and `apps/train-app-server/` entirely, including their `test/` directories and the two `*.spec.ts` files that made up the old baseline.

- [ ] **Step 4: Create the seven apps**

For each service, three files following the existing generated convention:

`apps/<service>/src/<service>.module.ts` — `@Module({})` with no imports, controllers, or providers, exporting `<Service>Module`.

`apps/<service>/src/main.ts` — `NestFactory.create(<Service>Module)` then `app.listen(process.env.PORT ?? 3000)`. Note `PORT`, uppercase, not the scaffold's lowercase `process.env.port`; compose sets `PORT`.

`apps/<service>/tsconfig.app.json` — copy of the deleted `apps/my-app/tsconfig.app.json`, with `outDir` set to `../../dist/apps/<service>`.

- [ ] **Step 5: Rewrite `nest-cli.json`'s projects and root**

Replace both existing `projects` entries with seven, each shaped like the deleted ones:

```json
"<service>": {
  "type": "application",
  "root": "apps/<service>",
  "entryFile": "main",
  "sourceRoot": "apps/<service>/src",
  "compilerOptions": { "tsConfigPath": "apps/<service>/tsconfig.app.json" }
}
```

Set top-level `"root": "apps/gateway"`, `"sourceRoot": "apps/gateway/src"`, and `compilerOptions.tsConfigPath` to `apps/gateway/tsconfig.app.json`. Keep `monorepo`, `webpack`, `deleteOutDir`, `collection`, `$schema` as they are.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 9 tests, 0 failures (2 config assertions + 7 module cases). The old 2-test baseline is gone by design; this is the new baseline.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace scaffold apps with seven empty service apps"
```

---

### Task 3: Create the three shared libs

**Files:**
- Create (per lib in `contracts`, `messaging`, `common`): `libs/<lib>/src/index.ts`, `libs/<lib>/src/<lib>.module.ts`, `libs/<lib>/tsconfig.lib.json`
- Modify: `nest-cli.json` (three `library` entries), `tsconfig.json` (`paths`)
- Test: `test/skeleton/libs.spec.ts`

**Interfaces:**
- Consumes: Task 2's `nest-cli.json` shape.
- Produces: three importable aliases — `@app/contracts`, `@app/messaging`, `@app/common` — each barrel re-exporting `ContractsModule`, `MessagingModule`, `CommonModule` respectively. Part 2 fills these; part 1 only makes the paths resolve.

- [ ] **Step 1: Write the failing test**

`test/skeleton/libs.spec.ts`:

```ts
import { readFileSync } from 'node:fs';

const LIBS = ['contracts', 'messaging', 'common'] as const;
const nestCli = JSON.parse(readFileSync('nest-cli.json', 'utf8'));
const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'));

describe('shared libs', () => {
  it('registers exactly the three libs as libraries', () => {
    const libs = Object.entries(nestCli.projects)
      .filter(([, p]: [string, any]) => p.type === 'library')
      .map(([name]) => name);
    expect(libs.sort()).toEqual([...LIBS].sort());
  });

  it.each(LIBS)('declares both tsconfig paths for @app/%s', (lib) => {
    expect(tsconfig.compilerOptions.paths[`@app/${lib}`]).toEqual([`libs/${lib}/src`]);
    expect(tsconfig.compilerOptions.paths[`@app/${lib}/*`]).toEqual([`libs/${lib}/src/*`]);
  });

  it('resolves each alias to a module export', async () => {
    const [contracts, messaging, common] = await Promise.all([
      import('@app/contracts'), import('@app/messaging'), import('@app/common'),
    ]);
    expect(contracts.ContractsModule).toBeDefined();
    expect(messaging.MessagingModule).toBeDefined();
    expect(common.CommonModule).toBeDefined();
  });
});
```

The third case is the one that matters: it proves `vite-tsconfig-paths` actually resolves the aliases, not just that they are written down.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skeleton/libs.spec.ts`
Expected: FAIL — no `library` entries, `paths` is `{}`, and the alias imports do not resolve.

- [ ] **Step 3: Create the three libs**

For each lib: `libs/<lib>/src/<lib>.module.ts` with an empty `@Module({})` exporting `<Lib>Module`; `libs/<lib>/src/index.ts` re-exporting it with `export * from './<lib>.module';`; `libs/<lib>/tsconfig.lib.json` extending `../../tsconfig.json` with `declaration: true`, `outDir: ../../dist/libs/<lib>`, `include: ["src/**/*"]`, `exclude: ["node_modules", "dist", "**/*spec.ts"]`.

- [ ] **Step 4: Register the libs**

Add three `nest-cli.json` `projects` entries:

```json
"<lib>": {
  "type": "library",
  "root": "libs/<lib>",
  "entryFile": "index",
  "sourceRoot": "libs/<lib>/src",
  "compilerOptions": { "tsConfigPath": "libs/<lib>/tsconfig.lib.json" }
}
```

Fill `tsconfig.json`'s empty `paths` with the six entries the test asserts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 14 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add contracts, messaging and common libs with path aliases"
```

---

### Task 4: Parameterized Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Test: verified by real build and run commands (steps 2 and 5), not a spec file

**Interfaces:**
- Consumes: `dist/apps/<service>/main` from Task 2's build output.
- Produces: an image buildable as `docker build --build-arg APP=<service> .`, whose default command runs that service. Task 6's compose services depend on the `APP` arg name.

- [ ] **Step 1: Verify a service builds at all before containerizing it**

Run: `npx nest build gateway && node dist/apps/gateway/main`
Expected: the Nest banner and a listening log, then Ctrl-C. This is Review Focus #3 — if ESM + webpack emits output Node refuses to run, it must surface here on the host, not as a silently exiting container.

If it fails, fix the build configuration before continuing; do not work around it in the Dockerfile.

- [ ] **Step 2: Write `.dockerignore`**

Exclude at minimum `node_modules`, `dist`, `.git`, `.claude`, `docs`, `**/*.spec.ts`, `test`, `.env`. Keeping `node_modules` out is what makes the build cache on `package*.json` work.

- [ ] **Step 3: Write the multi-stage `Dockerfile`**

Three stages on `node:24-alpine`:

1. `deps` — copy `package.json` and `package-lock.json`, run `npm ci`.
2. `build` — `ARG APP`, reuse `deps`' `node_modules`, copy the workspace, run `npx nest build $APP`.
3. `runtime` — copy `dist/` and a production-only `node_modules` (`npm ci --omit=dev`), run as the image's non-root `node` user, `EXPOSE 3000`.

The one non-obvious mechanic: `ARG` does not interpolate in exec-form `CMD`. Promote it and use shell form so the app name survives into the running container:

```dockerfile
ARG APP
ENV APP=${APP}
CMD ["sh", "-c", "node dist/apps/$APP/main"]
```

- [ ] **Step 4: Build two services to prove the arg is wired**

Run: `docker build --build-arg APP=gateway -t train-app/gateway . && docker build --build-arg APP=notification -t train-app/notification .`
Expected: both succeed. Building two, not one, is what catches an `APP` arg that is ignored and hardcoded.

- [ ] **Step 5: Run one image and confirm it serves**

Run: `docker run --rm -p 3000:3000 train-app/gateway`
Expected: the Nest startup log, and the process stays up. Stop it with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat: add parameterized multi-stage Dockerfile"
```

---

### Task 5: Compose the four infra containers

**Files:**
- Create: `docker-compose.yml` (infra only), `docker/postgres/init/01-create-databases.sql`, `.gitattributes`
- Test: `test/skeleton/compose.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: compose service names `postgres`, `redis`, `rabbitmq`, `mailpit`, each with a `healthcheck`, and seven databases named after the seven services. Task 6's `depends_on` and connection URLs use these names verbatim.

- [ ] **Step 1: Add the `yaml` devDependency**

Run: `npm install --save-dev yaml`
The compose spec needs to parse YAML. Nothing else in the repo does.

- [ ] **Step 2: Write the failing test**

`test/skeleton/compose.spec.ts`:

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const SERVICES = [
  'catalog', 'gateway', 'identity', 'inventory', 'booking', 'payment', 'notification',
] as const;
const INFRA = ['postgres', 'redis', 'rabbitmq', 'mailpit'] as const;

const compose = parse(readFileSync('docker-compose.yml', 'utf8'));
const initSql = readFileSync('docker/postgres/init/01-create-databases.sql', 'utf8');

describe('compose infrastructure', () => {
  it.each(INFRA)('defines %s with a healthcheck and a pinned image', (name) => {
    const svc = compose.services[name];
    expect(svc).toBeDefined();
    expect(svc.healthcheck?.test).toBeDefined();
    expect(svc.image).not.toMatch(/latest|^[^:]+$/);
  });

  it('creates one database per service', () => {
    for (const service of SERVICES) {
      expect(initSql).toMatch(new RegExp(`CREATE DATABASE ${service}\\b`, 'i'));
    }
  });

  it('commits container-executed files as LF', () => {
    const attrs = readFileSync('.gitattributes', 'utf8');
    expect(attrs).toMatch(/\*\.sql\s+text\s+eol=lf/);
    expect(attrs).toMatch(/\*\.sh\s+text\s+eol=lf/);
  });

  it('persists Postgres on a named volume so init runs exactly once', () => {
    expect(compose.volumes?.postgres_data).toBeDefined();
    expect(compose.services.postgres.volumes.some((v: string) => v.startsWith('postgres_data:')))
      .toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/skeleton/compose.spec.ts`
Expected: FAIL — `docker-compose.yml` does not exist.

- [ ] **Step 4: Write `.gitattributes`**

`* text=auto` plus explicit `*.sql text eol=lf` and `*.sh text eol=lf`. This is Review Focus #1: without it, Windows checkouts hand CRLF files to a Linux container.

- [ ] **Step 5: Write the Postgres init script**

`docker/postgres/init/01-create-databases.sql` — seven `CREATE DATABASE <service>;` statements. A `.sql` file rather than a `.sh`, deliberately: `docker-entrypoint-initdb.d` runs both, and SQL has no shebang to be broken by a stray carriage return.

- [ ] **Step 6: Write the infra half of `docker-compose.yml`**

Four services. The healthcheck commands are the part worth getting exactly right — each is the probe that image actually ships:

| service | image | healthcheck test |
|---|---|---|
| `postgres` | `postgres:17-alpine` | `pg_isready -U $POSTGRES_USER` |
| `redis` | `redis:8-alpine` | `redis-cli ping` |
| `rabbitmq` | `rabbitmq:4-management-alpine` | `rabbitmq-diagnostics -q ping` |
| `mailpit` | `axllent/mailpit:v1.21` | `/mailpit readyz` |

Each gets `interval: 10s`, `timeout: 5s`, `retries: 5`, `start_period: 10s`, and `restart: unless-stopped`. Mount `./docker/postgres/init` at `/docker-entrypoint-initdb.d` read-only, and `postgres_data` at `/var/lib/postgresql/data`. Declare named volumes for Postgres, Redis and RabbitMQ.

Published ports here are the dev UIs only — RabbitMQ management and Mailpit's inbox — each sourced from an `.env` variable per Review Focus #5. Postgres and Redis publish nothing.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 21 tests, 0 failures (14 from earlier tasks, plus 4 infra cases and 3 single assertions).

- [ ] **Step 8: Verify compose itself parses**

Run: `docker compose config --quiet`
Expected: exit 0, no output. This validates the file against Compose's own schema, which the YAML test cannot do.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add compose infrastructure with healthchecks and per-service databases"
```

---

### Task 6: Compose the seven services

**Files:**
- Modify: `docker-compose.yml` (add seven services), `test/skeleton/compose.spec.ts` (add service assertions)
- Create: `.env.example`

**Interfaces:**
- Consumes: Task 4's `APP` build arg; Task 5's infra service names and database names.
- Produces: seven compose services named for the seven apps, the gateway alone publishing a host port.

- [ ] **Step 1: Extend the failing test**

Append to `test/skeleton/compose.spec.ts`:

```ts
describe('compose services', () => {
  it('defines all seven services and no extras', () => {
    const defined = Object.keys(compose.services).filter((n) => !INFRA.includes(n as any));
    expect(defined.sort()).toEqual([...SERVICES].sort());
  });

  it.each(SERVICES)('%s builds from the shared Dockerfile with its own APP arg', (name) => {
    const svc = compose.services[name];
    expect(svc.build.dockerfile ?? 'Dockerfile').toBe('Dockerfile');
    expect(svc.build.args.APP).toBe(name);
  });

  it.each(SERVICES)('%s waits for healthy infra', (name) => {
    for (const dep of ['postgres', 'redis', 'rabbitmq']) {
      expect(compose.services[name].depends_on[dep].condition).toBe('service_healthy');
    }
  });

  it.each(SERVICES)('%s connects only to its own database', (name) => {
    expect(compose.services[name].environment.DATABASE_URL).toMatch(
      new RegExp(`@postgres:5432/${name}$`),
    );
  });

  it('publishes a host port for the gateway and for nothing else', () => {
    const published = SERVICES.filter((n) => compose.services[n].ports?.length);
    expect(published).toEqual(['gateway']);
  });

  it('documents every variable compose interpolates', () => {
    const example = readFileSync('.env.example', 'utf8');
    const raw = readFileSync('docker-compose.yml', 'utf8');
    const referenced = new Set(
      [...raw.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((m) => m[1]),
    );
    for (const key of referenced) expect(example).toMatch(new RegExp(`^${key}=`, 'm'));
  });
});
```

The last two carry the weight: the publish assertion is the spec's "only the gateway is reachable", and the `.env.example` assertion is Review Focus #5 and #2 — it fails the build if compose grows a variable a reviewer has no way to know about.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/skeleton/compose.spec.ts`
Expected: FAIL — `compose.services` holds only the four infra entries, and `.env.example` does not exist.

- [ ] **Step 3: Add the seven services to `docker-compose.yml`**

Each entry is the same shape, varying only by name. Use a YAML anchor for the shared parts rather than repeating them seven times:

```yaml
x-service: &service
  build:
    context: .
    dockerfile: Dockerfile
  restart: unless-stopped
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }
    rabbitmq: { condition: service_healthy }
  environment: &service-env
    NODE_ENV: ${NODE_ENV:-development}
    PORT: 3000
    REDIS_URL: redis://redis:6379
    RABBITMQ_URL: amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@rabbitmq:5672
```

Per service, set `build.args.APP` and a `DATABASE_URL` of `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/<service>`. The `gateway` additionally publishes `${GATEWAY_PORT:-3000}:3000`. The `notification` service additionally depends on `mailpit` being healthy and carries `SMTP_HOST: mailpit` and `SMTP_PORT: 1025`.

- [ ] **Step 4: Write `.env.example`**

Every variable the test's regex finds in compose, with working defaults for local development: `NODE_ENV`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `GATEWAY_PORT`, `RABBITMQ_MANAGEMENT_PORT`, `MAILPIT_UI_PORT`. These are local dev credentials, not secrets; `.env` itself is already gitignored.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 45 tests, 0 failures (21 from earlier tasks, plus 24 here: three seven-case suites and three single assertions).

- [ ] **Step 6: Verify compose resolves with a real `.env`**

Run: `cp .env.example .env && docker compose config --quiet`
Expected: exit 0. A missing variable would surface here as an interpolation warning.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add seven services to compose behind infra healthchecks"
```

---

### Task 7: README and full-stack verification

**Files:**
- Modify: `README.md`
- Test: the reviewer's own flow, run end to end

**Interfaces:**
- Consumes: everything above.
- Produces: the clone → `docker compose up` path the spec promises.

- [ ] **Step 1: Write the README**

Sections, in this order: what the repo is and the seven services in a table with their roles; prerequisites (Docker Desktop, Node 24); **getting started as exactly two commands** — `cp .env.example .env` then `docker compose up`; what comes up and on which host port; how to run one service on the host (`npm run start:dev <service>`); how to run tests; and a "resetting the databases" note explaining that Postgres init scripts run only on an empty volume, so adding a service later needs `docker compose down -v` (Review Focus #4).

Say plainly that the services are empty by design and that health endpoints, config validation and the response envelope arrive in the next story — otherwise a reviewer reads the skeleton as broken.

- [ ] **Step 2: Bring the whole stack up from scratch**

Run: `docker compose down -v && docker compose up --build`
Expected: the four infra containers report healthy, then all seven services start and log their Nest banner. No container restart-loops.

- [ ] **Step 3: Confirm the gateway is the only reachable service**

Run: `curl -i http://localhost:3000/`
Expected: a response from Nest (404 is correct — the gateway has no routes yet). The point is that the port answers.

Then confirm no other service port is published: `docker compose ps --format '{{.Service}} {{.Publishers}}'`
Expected: host ports only against `gateway`, `rabbitmq` and `mailpit`.

- [ ] **Step 4: Confirm the seven databases exist**

Run: `docker compose exec postgres psql -U "$POSTGRES_USER" -lqt`
Expected: all seven service databases listed.

- [ ] **Step 5: Tear down and run the test suite once more**

Run: `docker compose down && npm test`
Expected: PASS, 45 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: document the clone-to-compose-up flow"
```
