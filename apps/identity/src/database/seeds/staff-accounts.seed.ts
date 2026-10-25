import { hash } from 'bcryptjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dataSource from '../data-source.js';
import { STAFF_SEED_ACCOUNTS } from './staff-accounts.js';

type SeedAccount = (typeof STAFF_SEED_ACCOUNTS)[number];

const TABLE_WAIT_TIMEOUT_MS = 60_000;
const TABLE_POLL_INTERVAL_MS = 250;

/**
 * Resolve one staff password. Production must supply it explicitly: a
 * development password in production is worse than no seed at all.
 */
export function seedPassword(
  account: SeedAccount,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env[account.passwordEnv];
  if (configured && configured.length > 0) return configured;

  if (env.NODE_ENV === 'production') {
    throw new Error(
      `Missing required environment variable '${account.passwordEnv}': refusing to seed a staff account with a development password in production`,
    );
  }
  return account.developmentPassword;
}

function bcryptCost(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.BCRYPT_COST ?? 12);
  return Number.isInteger(configured) && configured >= 4 && configured <= 15
    ? configured
    : 12;
}

/**
 * Identity runs its migrations during `onApplicationBootstrap`, so a separate
 * seed process cannot assume `account` exists yet. Poll with a bound rather
 * than sleeping a fixed amount and hoping.
 */
async function waitForAccountTable(): Promise<void> {
  const deadline = Date.now() + TABLE_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const rows = (await dataSource.query(
      "SELECT to_regclass('public.account') AS name",
    )) as Array<{ name: string | null }>;
    if (rows[0]?.name) return;
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, TABLE_POLL_INTERVAL_MS),
    );
  }

  throw new Error(
    `Timed out after ${TABLE_WAIT_TIMEOUT_MS}ms waiting for identity's account table; run identity's migrations first`,
  );
}

async function seed(): Promise<void> {
  const cost = bcryptCost();
  const accounts = await Promise.all(
    STAFF_SEED_ACCOUNTS.map(async (account) => ({
      ...account,
      passwordHash: await hash(seedPassword(account), cost),
    })),
  );

  let initialized = false;

  try {
    await dataSource.initialize();
    initialized = true;
    await waitForAccountTable();

    const now = new Date();

    for (const account of accounts) {
      const inserted = (await dataSource.query(
        `
          INSERT INTO account (
            id,
            email,
            language,
            status,
            created_at,
            password_hash,
            password_updated_at,
            email_verified_at,
            bookable,
            roles
          )
          SELECT
            $1, $2, 'en', 'active', $3, $4, $3, $3, false, ARRAY[$5]::text[]
          WHERE NOT EXISTS (
            SELECT 1 FROM account WHERE lower(email) = lower($2)
          )
          RETURNING id
        `,
        [
          account.id,
          account.email,
          now,
          account.passwordHash,
          account.role,
        ],
      )) as Array<{ id: string }>;

      console.log(
        inserted.length > 0
          ? `seed: created ${account.email} (${account.role})`
          : `seed: ${account.email} already present`,
      );
    }
  } finally {
    if (initialized && dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    import.meta.url === pathToFileURL(resolve(entry)).href
  );
}

if (isEntrypoint()) {
  seed().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`seed: ${message}`);
    process.exitCode = 1;
  });
}
