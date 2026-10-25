import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const SERVICES = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;
const INFRA = ['postgres', 'redis', 'rabbitmq', 'mailpit'] as const;
const ONE_SHOT = ['identity-seed'] as const;

// `merge: true` is required, not cosmetic: the `yaml` package leaves `<<` as a
// literal key under the YAML 1.2 core schema, while Docker Compose resolves
// merge keys. Without it this suite would read a different file than Compose
// does, and the shared `x-service` anchor would look like missing config.
const compose = parse(readFileSync('docker-compose.yml', 'utf8'), {
  merge: true,
});
// A .sh rather than a .sql: the per-service passwords come from the
// environment, and .sql cannot interpolate them. `.gitattributes` pins *.sh to
// LF, so the usual CRLF-shebang hazard is closed.
const initScript = readFileSync(
  'docker/postgres/init/01-create-databases.sh',
  'utf8',
);

describe('compose infrastructure', () => {
  it.each(INFRA)('defines %s with a healthcheck and a pinned image', (name) => {
    const svc = compose.services[name];
    expect(svc).toBeDefined();
    expect(svc.healthcheck?.test).toBeDefined();
    expect(svc.image).not.toMatch(/latest|^[^:]+$/);
  });

  // `toBeDefined()` above would accept `['CMD', 'true']`. This pins the one
  // probe whose exact spelling is load-bearing: Compose interpolates `$VAR`
  // itself, so a single-`$` `pg_isready -U $POSTGRES_USER` is substituted at
  // parse time, reaches the container empty, and Postgres never reports
  // healthy — leaving all seven services waiting on service_healthy forever.
  // CMD-SHELL is required too: exec form has no shell to expand anything.
  it('probes Postgres with a command that resolves inside the container', () => {
    const [form, script] = compose.services.postgres.healthcheck.test;
    expect(form).toBe('CMD-SHELL');
    expect(script).toMatch(/\$\$POSTGRES_USER/);
    expect(script).not.toMatch(/[^$]\$[A-Z]/);
  });

  it('creates one database per service', () => {
    for (const service of SERVICES) {
      expect(initScript).toMatch(
        new RegExp(`create_service_database\\s+${service}\\b`),
      );
    }
  });

  it('gives each service its own login role, owning only its own database', () => {
    expect(initScript).toMatch(
      /CREATE ROLE :"service" LOGIN PASSWORD :'password'/,
    );
    // Owner, so the service has full DDL on its own database and can run its
    // own migrations without any extra grant.
    expect(initScript).toMatch(/CREATE DATABASE :"service" OWNER :"service"/);
    // Creating roles is not enough on its own: Postgres grants CONNECT on a new
    // database to PUBLIC, so without this every role could open every database.
    expect(initScript).toMatch(
      /REVOKE CONNECT ON DATABASE :"service" FROM PUBLIC/,
    );
  });

  it('refuses to create a service database with an empty password', () => {
    expect(initScript).toMatch(/if \[ -z "\$password" \]/);
  });

  // Review Focus #1. `*.sql` and `*.sh` are the files the plan named; the
  // Dockerfile is read by the Linux daemon for the same reason and is pinned
  // here too, because `core.autocrlf` would otherwise hand a Windows clone a
  // CRLF copy of it.
  it('commits container-executed files as LF', () => {
    const attrs = readFileSync('.gitattributes', 'utf8');
    expect(attrs).toMatch(/\*\.sql\s+text\s+eol=lf/);
    expect(attrs).toMatch(/\*\.sh\s+text\s+eol=lf/);
    expect(attrs).toMatch(/^Dockerfile\s+text\s+eol=lf/m);
    expect(attrs).toMatch(/^\.env\.example\s+text\s+eol=lf/m);
  });

  it('persists Postgres on a named volume so init runs exactly once', () => {
    expect(compose.volumes?.postgres_data).toBeDefined();
    expect(
      compose.services.postgres.volumes.some((v: string) =>
        v.startsWith('postgres_data:'),
      ),
    ).toBe(true);
  });
});

describe('compose services', () => {
  it('defines all seven services, the staff seed and no extras', () => {
    const defined = Object.keys(compose.services).filter(
      (n) => !INFRA.includes(n as any) && !ONE_SHOT.includes(n as any),
    );
    expect(defined.sort()).toEqual([...SERVICES].sort());
  });

  it('runs the staff seed as a one-shot after identity starts', () => {
    const seed = compose.services['identity-seed'];
    expect(seed.build.args.APP).toBe('identity');
    expect(seed.restart).toBe('no');
    expect(seed.command).toContain('staff-accounts.seed.js');
    expect(seed.depends_on.identity.condition).toBe('service_started');
    expect(seed.environment.OPERATOR_SEED_PASSWORD).toBeDefined();
    expect(seed.environment.CONDUCTOR_SEED_PASSWORD).toBeDefined();
  });

  it.each(SERVICES)(
    '%s builds from the shared Dockerfile with its own APP arg',
    (name) => {
      const svc = compose.services[name];
      expect(svc.build.dockerfile ?? 'Dockerfile').toBe('Dockerfile');
      expect(svc.build.args.APP).toBe(name);
    },
  );

  it.each(SERVICES)('%s waits for healthy infra', (name) => {
    for (const dep of ['postgres', 'redis', 'rabbitmq']) {
      expect(compose.services[name].depends_on[dep].condition).toBe(
        'service_healthy',
      );
    }
  });

  it.each(SERVICES)('%s connects only to its own database', (name) => {
    expect(compose.services[name].environment.DATABASE_URL).toMatch(
      new RegExp(`@postgres:5432/${name}$`),
    );
  });

  // Spec point 5: "each service holding credentials for its own only". Naming
  // its own database is not enough — authenticating as the superuser would let
  // any service open any other's. The credential has to be the service's own.
  it.each(SERVICES)(
    '%s authenticates as its own role, never the superuser',
    (name) => {
      const url = compose.services[name].environment.DATABASE_URL;
      expect(url).toMatch(new RegExp(`^postgres://${name}:`));
      expect(url).not.toContain('POSTGRES_USER');
      expect(url).not.toContain('POSTGRES_PASSWORD');
    },
  );

  it('publishes a host port for the gateway and for nothing else', () => {
    const published = SERVICES.filter((n) => compose.services[n].ports?.length);
    expect(published).toEqual(['gateway']);
  });

  // The assertion above only looks at the seven app services, so publishing
  // Postgres on 5432 or Redis on 6379 would pass it while breaking spec point
  // 7. This one covers every service in the file, infra included.
  it('exposes nothing to the host beyond the gateway and the two dev UIs', () => {
    const publishing = Object.keys(compose.services).filter(
      (n) => compose.services[n].ports?.length,
    );
    expect(publishing.sort()).toEqual(['gateway', 'mailpit', 'rabbitmq']);
  });

  // Review Focus #5: a reviewer must be able to move a colliding port without
  // editing compose. Sourcing every published port from a variable is what
  // makes that true; hardcoding '3000:3000' would otherwise pass the suite,
  // since the .env.example test would simply stop finding GATEWAY_PORT.
  it('sources every published host port from an environment variable', () => {
    for (const name of Object.keys(compose.services)) {
      for (const mapping of compose.services[name].ports ?? []) {
        expect(mapping).toMatch(
          /^(127\.0\.0\.1:)?\$\{[A-Z0-9_]+(:-\d+)?\}:\d+$/,
        );
      }
    }
  });

  it('documents every variable compose interpolates', () => {
    const example = readFileSync('.env.example', 'utf8');
    const raw = readFileSync('docker-compose.yml', 'utf8');
    const referenced = new Set(
      [...raw.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((m) => m[1]),
    );
    for (const key of referenced)
      expect(example).toMatch(new RegExp(`^${key}=`, 'm'));
  });
});
