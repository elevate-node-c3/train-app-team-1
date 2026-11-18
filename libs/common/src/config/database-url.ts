/**
 * The one reader for DATABASE_URL, shared by every service, its TypeORM CLI
 * data source and its seeds.
 *
 * No fallback on purpose. commonEnvSchema already declares DATABASE_URL
 * required, so an absent value means the service is misconfigured — and a
 * hardcoded `postgres://service:service_dev@localhost:5432/service` turns that
 * into a service quietly talking to the wrong database, or to none, instead of
 * refusing to start.
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Missing required environment variable 'DATABASE_URL'");
  }
  return url;
}
