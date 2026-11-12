/** §2.5 allows `process.env` only in `config/`, `main.ts` and module files. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily. Overridable so a test need not wait a day for the second tick. */
export function tripGenerationIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.TRIP_GENERATION_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DAY_MS;
}

/** On unless switched off, so a fresh database fills its window unattended. */
export function tripGenerationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TRIP_GENERATION_ENABLED !== 'false';
}

/**
 * Runs `work` with both background jobs off, for the seed.
 *
 * Generation would start before the seed has written anything, then generate
 * the dates the seed publishes itself. The relay would claim outbox rows and
 * die mid-publish when the seed exits; the running service ships them instead.
 *
 * Writes `process.env`, so it is process-wide and only safe in a one-shot script.
 */
export async function withBackgroundJobsDisabled<T>(
  work: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const previous = {
    relay: env.OUTBOX_RELAY_ENABLED,
    generation: env.TRIP_GENERATION_ENABLED,
  };

  env.OUTBOX_RELAY_ENABLED = 'false';
  env.TRIP_GENERATION_ENABLED = 'false';

  try {
    return await work();
  } finally {
    restore(env, 'OUTBOX_RELAY_ENABLED', previous.relay);
    restore(env, 'TRIP_GENERATION_ENABLED', previous.generation);
  }
}

function restore(
  env: NodeJS.ProcessEnv,
  key: string,
  previous: string | undefined,
): void {
  if (previous === undefined) delete env[key];
  else env[key] = previous;
}
