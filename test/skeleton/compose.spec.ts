import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const SERVICES = [
  'catalog', 'gateway', 'identity', 'inventory', 'booking', 'payment', 'notification',
] as const;
const INFRA = ['postgres', 'redis', 'rabbitmq', 'mailpit'] as const;

// `merge: true` is required, not cosmetic: the `yaml` package leaves `<<` as a
// literal key under the YAML 1.2 core schema, while Docker Compose resolves
// merge keys. Without it this suite would read a different file than Compose
// does, and the shared `x-service` anchor would look like missing config.
const compose = parse(readFileSync('docker-compose.yml', 'utf8'), { merge: true });
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
    expect(compose.services.postgres.volumes.some((v: string) => v.startsWith('postgres_data:')))
      .toBe(true);
  });
});

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
