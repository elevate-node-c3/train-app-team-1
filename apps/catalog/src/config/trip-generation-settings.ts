/** Read process.env only in config, main.ts, and module files. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily by default; tests can shorten the interval. */
export function tripGenerationIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.TRIP_GENERATION_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DAY_MS;
}

/** Enabled by default so fresh databases fill the booking window automatically. */
export function tripGenerationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.TRIP_GENERATION_ENABLED !== 'false';
}

/**
 * Disable seed-time generation and relay to avoid duplicate trips and interrupted
 * publishes. The running service sends seeded outbox rows instead.
 * Changes to process.env are process-wide; use only in one-shot scripts.
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
