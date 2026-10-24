import { execFileSync } from 'node:child_process';

const SERVICES = [
  'catalog',
  'gateway',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;

type Credentials = { user: string; password: string; database: string };

function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Reads each service's real credentials out of the resolved compose config. */
function credentialsFor(service: string, config: any): Credentials {
  const url = new URL(config.services[service].environment.DATABASE_URL);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

/** Opens a connection inside the container; returns true when it succeeds. */
function canConnect(as: Credentials, database: string): boolean {
  try {
    compose(
      'exec',
      '-T',
      '--env',
      `PGPASSWORD=${as.password}`,
      'postgres',
      'psql',
      '--username',
      as.user,
      '--dbname',
      database,
      '--no-password',
      '--tuples-only',
      '--command',
      'SELECT 1',
    );
    return true;
  } catch {
    return false;
  }
}

// Needs Docker. The init script only runs against an empty data directory, so
// proving what it created means starting from one — which is why this lives in
// the e2e suite and not in `npm test`, and why it destroys the local volumes.
describe('per-service database credentials', () => {
  let config: any;

  beforeAll(() => {
    compose('down', '-v', '--remove-orphans');
    compose('up', '-d', '--wait', '--wait-timeout', '180', 'postgres');
    config = JSON.parse(compose('config', '--format', 'json'));
  }, 420_000);

  afterAll(() => {
    compose('down', '-v');
  }, 180_000);

  it.each(SERVICES)(
    '%s can open its own database with its own credentials',
    (service) => {
      const creds = credentialsFor(service, config);
      expect(creds.user).toBe(service);
      expect(canConnect(creds, creds.database)).toBe(true);
    },
  );

  // The assertion the spec sentence actually turns on. Every service is paired
  // with the next one round the ring, so all seven are covered as both the
  // caller and the target.
  it.each(
    SERVICES.map((s, i) => [s, SERVICES[(i + 1) % SERVICES.length]] as const),
  )('%s cannot open the %s database', (service, other) => {
    expect(canConnect(credentialsFor(service, config), other)).toBe(false);
  });

  it('still lets the superuser reach every database, so admin and healthchecks work', () => {
    const postgres = config.services.postgres.environment;
    const superuser = {
      user: postgres.POSTGRES_USER,
      password: postgres.POSTGRES_PASSWORD,
      database: postgres.POSTGRES_DB,
    };
    for (const service of SERVICES) {
      expect(canConnect(superuser, service)).toBe(true);
    }
  });

  it('lets a service create tables in its own database, for its own migrations', () => {
    const creds = credentialsFor('booking', config);
    expect(() =>
      compose(
        'exec',
        '-T',
        '--env',
        `PGPASSWORD=${creds.password}`,
        'postgres',
        'psql',
        '--username',
        creds.user,
        '--dbname',
        creds.database,
        '--no-password',
        '--command',
        'CREATE TABLE migration_probe (id int); DROP TABLE migration_probe;',
      ),
    ).not.toThrow();
  });
});
