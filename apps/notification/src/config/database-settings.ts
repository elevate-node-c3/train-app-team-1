/**
 * Composition-root parsing for the TypeORM CLI. The running service gets its
 * options from `createTypeOrmAsyncOptions`; this keeps the `process.env` read
 * in `config/` for the standalone tool too.
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://notification:notification_dev@localhost:5432/notification'
  );
}
