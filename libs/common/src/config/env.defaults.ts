/**
 * Keep these fallbacks in sync with Joi defaults. Joi does not write defaults
 * to `process.env`, so readers still need fallback values.
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
export const DEFAULT_EVENT_RETRY_DELAYS_MS: readonly number[] = [
  1000, 3000, 9000,
];
