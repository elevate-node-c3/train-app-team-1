/** Read the database URL for the TypeORM CLI and staff seed. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://identity:identity_dev@localhost:5432/identity'
  );
}
