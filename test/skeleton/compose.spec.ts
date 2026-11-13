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
const ONE_SHOT = ['seeder'] as const;

// Resolve YAML merge keys like Compose; otherwise `<<` stays a literal key
// and config from the shared x-service anchor appears missing.
const compose = parse(readFileSync('docker-compose.yml', 'utf8'), {
  merge: true,
});
// Use .sh because .sql cannot read passwords from the environment.
// .gitattributes keeps shell scripts at LF so their shebangs work.
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

  // `$$` delays variable expansion until the container runs the probe.
  // A single `$` lets Compose substitute an empty value, blocking app startup.
  // CMD-SHELL supplies the shell needed for expansion.
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
    // Ownership lets each service run its own migrations.
    expect(initScript).toMatch(/CREATE DATABASE :"service" OWNER :"service"/);
    // Postgres grants CONNECT to PUBLIC by default, so roles alone do not isolate databases.
    expect(initScript).toMatch(
      /REVOKE CONNECT ON DATABASE :"service" FROM PUBLIC/,
    );
  });

  it('refuses to create a service database with an empty password', () => {
    expect(initScript).toMatch(/if \[ -z "\$password" \]/);
  });

  // Pin LF for Linux-read files even on Windows clones.
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
  it('defines all seven services, the seeder and no extras', () => {
    const defined = Object.keys(compose.services).filter(
      (n) => !INFRA.includes(n as any) && !ONE_SHOT.includes(n as any),
    );
    expect(defined.sort()).toEqual([...SERVICES].sort());
  });

  it('keeps the seeder as an opt-in one-shot', () => {
    const seed = compose.services.seeder;
    // A profile keeps it out of `compose up`; `compose run --rm seeder` is the
    // only way it starts, and its image merges identity's and catalog's seeds.
    expect(seed.profiles).toEqual(['seed']);
    expect(seed.build.target).toBe('seeder');
    expect(seed.restart ?? 'no').toBe('no');
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

  // A database name is not isolation if the service logs in as the superuser.
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

  it('exposes nothing to the host beyond the gateway and the two dev UIs', () => {
    const publishing = Object.keys(compose.services).filter(
      (n) => compose.services[n].ports?.length,
    );
    expect(publishing.sort()).toEqual(['gateway', 'mailpit', 'rabbitmq']);
  });

  // Let developers change colliding host ports without editing Compose.
  // The env example check alone would miss a hardcoded port.
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
