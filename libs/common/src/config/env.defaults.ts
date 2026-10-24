/**
 * Code-side defaults that must match the Joi `.default()` values.
 *
 * `validateEnv()` discards the coerced result, so a Joi default never reaches
 * `process.env`; code reads the variable with `?? default`. Keeping both
 * numbers here and asserting they match in `joi-env-validation.spec.ts` is what
 * stops the two from drifting.
 */
export const OUTBOX_DEFAULTS = {
  enabled: true,
  pollIntervalMs: 500,
  batchSize: 20,
} as const;

export const VERIFICATION_CODE_DEFAULTS = {
  ttlSeconds: 600,
} as const;

export const NOTIFICATION_DEFAULTS = {
  smtpFrom: 'no-reply@train.local',
  handlerTimeoutMs: 3000,
  retryDelays: '1000,3000,9000',
  prefetch: 10,
  claimLeaseSeconds: 60,
} as const;

/** Parsed form of the default `EVENT_RETRY_DELAYS_MS`. */
export const DEFAULT_EVENT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];
