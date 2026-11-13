/** Keep environment reads in config for the TypeORM CLI and station seed. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ?? 'postgres://catalog:catalog_dev@localhost:5432/catalog'
  );
}

/** Seeds use the container URL or fall back to the host's published test port. */
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
