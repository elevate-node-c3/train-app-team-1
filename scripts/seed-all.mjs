// Seeds every service's database, on demand.
//
// Plain .mjs so it needs no compilation, like scripts/generate-dev-keys.mjs.
// Each seed runs as its own process, because a seed resolves its connection
// from DATABASE_URL and one process can only hold one value.
//
// Idempotent throughout: every seed either keys its rows by a fixed uuid or
// checks before inserting, so running this again inserts nothing new.

import { spawn } from 'node:child_process';

const ADMIN_USER = process.env.POSTGRES_USER ?? 'postgres';
const ADMIN_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'postgres';
const HOST = process.env.POSTGRES_HOST ?? 'postgres';
const PORT = process.env.POSTGRES_PORT ?? '5432';

/** Admin credentials, so one seeder reaches databases owned by seven roles. */
function adminUrl(database) {
  const user = encodeURIComponent(ADMIN_USER);
  const password = encodeURIComponent(ADMIN_PASSWORD);
  return `postgres://${user}:${password}@${HOST}:${PORT}/${database}`;
}

/**
 * Run order is dependency order: identity's operator must exist before anyone
 * signs in, and catalog's network before trips reference it.
 */
const SEEDS = [
  {
    name: 'identity: staff accounts',
    database: 'identity',
    script: 'dist/apps/identity/src/database/seeds/staff-accounts.seed.js',
  },
  {
    name: 'catalog: network, timetable and generated trips',
    database: 'catalog',
    script: 'dist/apps/catalog/src/database/seeds/catalog.seed.js',
  },
  {
    name: "catalog: trips on today's dates",
    database: 'catalog',
    script: 'dist/apps/catalog/src/database/seeds/today-trips.seed.js',
  },
];

/**
 * Waits until the database has applied migrations.
 *
 * The seeder holds admin credentials, so a table it created would be owned by
 * the superuser and the service's own role could not write to it. Seeding only
 * after the service has migrated keeps every object owned by its service.
 */
async function waitForMigrations(database) {
  const deadline = Date.now() + 120_000;
  let lastError = 'no applied migrations';

  while (Date.now() < deadline) {
    try {
      const { rows } = await query(
        database,
        'SELECT count(*)::int AS applied FROM migrations',
      );
      if (rows[0].applied > 0) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((settle) => setTimeout(settle, 1000));
  }

  throw new Error(
    `${database} is not migrated after 120s (${lastError}); start the ${database} service first`,
  );
}

async function query(database, sql) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: adminUrl(database),
    connectionTimeoutMillis: 5000,
  });

  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

function run({ name, database, script }) {
  return new Promise((resolve, reject) => {
    console.log(`\nseed-all: ${name}`);

    const child = spawn('node', [script], {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: adminUrl(database),
        // The seeds' own background jobs stay off; the running services own them.
        OUTBOX_RELAY_ENABLED: 'false',
        TRIP_GENERATION_ENABLED: 'false',
      },
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${code}`));
    });
  });
}

async function main() {
  const waitedFor = new Set();

  for (const seed of SEEDS) {
    if (!waitedFor.has(seed.database)) {
      await waitForMigrations(seed.database);
      waitedFor.add(seed.database);
    }
    await run(seed);
  }

  console.log('\nseed-all: done. Running it again changes nothing.');
}

main().catch((error) => {
  console.error(`\nseed-all: ${error.message}`);
  process.exitCode = 1;
});
