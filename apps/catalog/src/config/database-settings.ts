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