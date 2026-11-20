import { databaseUrlFromEnv } from '@app/common/config/database-url.js';

/** Compose publishes the development Postgres here for host-side tooling. */
const HOST_POSTGRES_PORT = '15432';

/**
 * The seed and the TypeORM CLI run on the host, not in the container, so
 * DATABASE_URL — which names `postgres` as its host — is absent there. They
 * reach the same database through the port compose publishes.
 *
 * A running service never takes this path: databaseUrlFromEnv stays strict, so
 * a misconfigured container fails at boot instead of quietly connecting
 * somewhere else.
 */
export function seedDatabaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.CATALOG_TEST_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const password = env.CATALOG_DB_PASSWORD?.trim() || 'catalog_dev';
  const port = env.POSTGRES_HOST_PORT?.trim() || HOST_POSTGRES_PORT;
  return `postgres://catalog:${password}@127.0.0.1:${port}/catalog`;
}

/** Re-exported so catalog's own config stays the one import site. */
export { databaseUrlFromEnv };
