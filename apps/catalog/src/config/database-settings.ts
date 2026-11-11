/**
 * Composition-root parsing for the TypeORM CLI and the station seed. The running
 * service gets its options from `createTypeOrmAsyncOptions`; this keeps the
 * `process.env` read in `config/` for the standalone tools too.
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://catalog:catalog_dev@localhost:5432/catalog'
  );
}

/**
 * For the dated-trip seeds, which run both inside the container and on the
 * host. `DATABASE_URL` is set in the container; the fallback is the port
 * `docker-compose.override.yml` publishes for the e2e tier.
 */
export function seedDatabaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.CATALOG_TEST_DATABASE_URL ??
    env.DATABASE_URL ??
    `postgres://catalog:${env.CATALOG_DB_PASSWORD ?? 'catalog_dev'}@127.0.0.1:${
      env.POSTGRES_HOST_PORT ?? '15432'
    }/catalog`
  );
}