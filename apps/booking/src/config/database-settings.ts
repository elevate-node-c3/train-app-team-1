/** Read the database URL for the TypeORM CLI and service migrations. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://booking:booking_dev@localhost:5432/booking'
  );
}
