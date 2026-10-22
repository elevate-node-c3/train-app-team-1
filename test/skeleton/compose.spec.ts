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

  // Review Focus #1. `*.sql` and `*.sh` are the files the plan named; the
  // Dockerfile is read by the Linux daemon for the same reason and is pinned
  // here too, because `core.autocrlf` would otherwise hand a Windows clone a
  // CRLF copy of it.
  it('commits container-executed files as LF', () => {
    const attrs = readFileSync('.gitattributes', 'utf8');
    expect(attrs).toMatch(/\*\.sql\s+text\s+eol=lf/);
    expect(attrs).toMatch(/\*\.sh\s+text\s+eol=lf/);
    expect(attrs).toMatch(/^Dockerfile\s+text\s+eol=lf/m);
  });

  it('persists Postgres on a named volume so init runs exactly once', () => {
    expect(compose.volumes?.postgres_data).toBeDefined();
    expect(compose.services.postgres.volumes.some((v: string) => v.startsWith('postgres_data:')))
      .toBe(true);
  });
});
