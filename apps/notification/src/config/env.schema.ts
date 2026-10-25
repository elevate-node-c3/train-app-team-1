import Joi from 'joi';
import { commonEnvSchema } from '@app/common/config/env.schema.js';
import { NOTIFICATION_DEFAULTS } from '@app/common/config/env.defaults.js';
import {
  assertDeliveryBudget,
  EVENT_HANDLER_TIMEOUT_MS as DEFAULT_HANDLER_TIMEOUT_MS,
  OUTBOX_POLL_INTERVAL_MS as DEFAULT_POLL_INTERVAL_MS,
} from '@app/messaging/retry-budget.js';

function parseDelays(value: string): number[] {
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isInteger(part) && part >= 0);
}

/**
 * The budget check runs on the *configured* handler timeout and poll interval,
 * not on the defaults, so a longer timeout cannot quietly push the worst case
 * past the 30s target while the delays stay unchanged.
 */
const retryDelays = Joi.string()
  .pattern(/^\d+(,\d+)*$/)
  .default(NOTIFICATION_DEFAULTS.retryDelays)
  .custom((value: string, helpers) => {
    const root = (helpers.state.ancestors[0] ?? {}) as Record<string, unknown>;
    const handlerTimeoutMs = Number(
      root.EVENT_HANDLER_TIMEOUT_MS ?? DEFAULT_HANDLER_TIMEOUT_MS,
    );
    const pollIntervalMs = Number(
      root.OUTBOX_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
    );
    try {
      assertDeliveryBudget({
        pollIntervalMs,
        handlerTimeoutMs,
        retryDelaysMs: parseDelays(value),
      });
      return value;
    } catch (error: unknown) {
      return helpers.error('any.custom', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
  .messages({ 'any.custom': '{{#message}}' });

export const notificationEnvSchema = commonEnvSchema.keys({
  SMTP_HOST: Joi.string().required().messages({
    'any.required': "Missing required environment variable 'SMTP_HOST'",
  }),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).required().messages({
    'number.base': "Variable 'SMTP_PORT' must be a valid integer port",
    'any.required': "Missing required environment variable 'SMTP_PORT'",
  }),
  SMTP_FROM: Joi.string().default(NOTIFICATION_DEFAULTS.smtpFrom),
  EVENT_HANDLER_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1)
    .default(NOTIFICATION_DEFAULTS.handlerTimeoutMs),
  EVENT_RETRY_DELAYS_MS: retryDelays,
  EVENT_PREFETCH: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(NOTIFICATION_DEFAULTS.prefetch),
  EVENT_CLAIM_LEASE_SECONDS: Joi.number()
    .integer()
    .min(1)
    .default(NOTIFICATION_DEFAULTS.claimLeaseSeconds),
});
