import { databaseUrlFromEnv } from '@app/common/config/database-url.js';

/** Seeds use the container URL or fall back to the host's published test port. */
export function seedDatabaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CATALOG_TEST_DATABASE_URL ?? databaseUrlFromEnv(env);
}
