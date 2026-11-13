/** Keep environment reads in config for the TypeORM CLI. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://inventory:inventory_dev@localhost:5432/inventory'
  );
}
