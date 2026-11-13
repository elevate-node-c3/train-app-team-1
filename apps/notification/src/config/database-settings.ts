/** Local database fallback for the TypeORM CLI. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://notification:notification_dev@localhost:5432/notification'
  );
}
