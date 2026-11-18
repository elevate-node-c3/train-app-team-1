/** Read database URLs from the environment for the TypeORM CLI and service migrations. */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DATABASE_URL ??
    'postgres://inventory:inventory_dev@localhost:5432/inventory'
  );
}
