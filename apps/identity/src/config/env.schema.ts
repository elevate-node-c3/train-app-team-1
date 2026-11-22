import Joi from 'joi';
import { TOKEN_DEFAULTS } from '@app/contracts';
import { commonEnvSchema } from '@app/common/config/env.schema.js';
import {
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import { MAX_RELAY_POLL_INTERVAL_MS } from '@app/messaging/retry-budget.js';
import { holdPassengerTokenSettingsFromEnv } from './hold-passenger-token-settings.js';

/** Only identity runs the outbox relay. */
export const identityEnvSchema = commonEnvSchema
  .keys({
    OUTBOX_RELAY_ENABLED: Joi.boolean()
      .truthy('true')
      .falsy('false')
      .default(OUTBOX_DEFAULTS.enabled),
    // Bound the relay's share of the delivery budget; notification owns the rest.
    OUTBOX_POLL_INTERVAL_MS: Joi.number()
      .integer()
      .min(1)
      .max(MAX_RELAY_POLL_INTERVAL_MS)
      .default(OUTBOX_DEFAULTS.pollIntervalMs)
      .messages({
        'number.max':
          "Variable 'OUTBOX_POLL_INTERVAL_MS' must be <= {{#limit}}ms: the relay's share of the delivery budget under the documented consumer retry policy",
      }),
    OUTBOX_BATCH_SIZE: Joi.number()
      .integer()
      .min(1)
      .max(1000)
      .default(OUTBOX_DEFAULTS.batchSize),
    // Keep the ten-minute cap, including for dead-lettered codes.
    VERIFICATION_CODE_TTL_SECONDS: Joi.number()
      .integer()
      .min(1)
      .max(600)
      .default(VERIFICATION_CODE_DEFAULTS.ttlSeconds)
      .messages({
        'number.max':
          "Variable 'VERIFICATION_CODE_TTL_SECONDS' must be <= 600: a verification code must die within ten minutes",
      }),
    // Identity alone holds the signing key; require inline PEM or a file.
    JWT_KEY_ID: Joi.string().default('dev-1'),
    JWT_PRIVATE_KEY: Joi.string().optional(),
    JWT_PRIVATE_KEY_FILE: Joi.string().optional(),
    ACCESS_TOKEN_TTL_SECONDS: Joi.number()
      .integer()
      .min(60)
      .max(3600)
      .default(TOKEN_DEFAULTS.accessTtlSeconds),
    REFRESH_TOKEN_TTL_SECONDS: Joi.number()
      .integer()
      .min(300)
      .default(TOKEN_DEFAULTS.refreshTtlSeconds),
    REFRESH_TOKEN_GRACE_SECONDS: Joi.number()
      .integer()
      .min(0)
      .max(300)
      .default(TOKEN_DEFAULTS.refreshGraceSeconds),
    TOKEN_GRACE_SECRET: Joi.string().optional(),
    BCRYPT_COST: Joi.number().integer().min(4).max(15).default(12),
    BOOKING_IDENTITY_SERVICE_KEY: Joi.string().empty('').min(32).optional(),
    NOTIFICATION_IDENTITY_SERVICE_KEY: Joi.string()
      .empty('')
      .min(32)
      .optional(),
    NATIONAL_ID_ACTIVE_KEY_VERSION: Joi.string()
      .pattern(/^[1-9]\d*$/)
      .required(),
    NATIONAL_ID_BLIND_INDEX_KEY: Joi.string()
      .base64()
      .custom((value: string, helpers) =>
        Buffer.from(value, 'base64').length === 32
          ? value
          : helpers.error('any.invalid'),
      )
      .required(),
    NATIONAL_ID_ENCRYPTION_KEYS: Joi.string()
      .required()
      .custom((value: string, helpers) => {
        try {
          const keys = JSON.parse(value) as Record<string, unknown>;
          const env = helpers.state.ancestors[0] as Record<string, unknown>;
          const version = env.NATIONAL_ID_ACTIVE_KEY_VERSION;
          const active = typeof version === 'string' ? version : '';
          if (
            !keys ||
            typeof keys !== 'object' ||
            Array.isArray(keys) ||
            !Object.prototype.hasOwnProperty.call(keys, active) ||
            Object.entries(keys).some(
              ([version, key]) =>
                !/^[1-9]\d*$/.test(version) ||
                typeof key !== 'string' ||
                Buffer.from(key, 'base64').length !== 32,
            )
          )
            return helpers.error('any.invalid');
          return value;
        } catch {
          return helpers.error('any.invalid');
        }
      }),
    HOLD_PASSENGER_TOKEN_ACTIVE_VERSION: Joi.string()
      .empty('')
      .pattern(/^[1-9]\d*$/)
      .optional(),
    HOLD_PASSENGER_TOKEN_KEYS: Joi.string()
      .empty('')
      .optional()
      .custom((value: string, helpers) => {
        const env = helpers.state.ancestors[0] as Record<string, unknown>;
        try {
          holdPassengerTokenSettingsFromEnv({
            HOLD_PASSENGER_TOKEN_KEYS: value,
            HOLD_PASSENGER_TOKEN_ACTIVE_VERSION:
              env.HOLD_PASSENGER_TOKEN_ACTIVE_VERSION,
          });
          return value;
        } catch {
          return helpers.error('any.invalid');
        }
      })
      .messages({
        'any.invalid':
          'HOLD_PASSENGER_TOKEN_KEYS must map positive integer versions to base64 secrets of at least 32 bytes and include HOLD_PASSENGER_TOKEN_ACTIVE_VERSION',
      }),
  })
  .and('HOLD_PASSENGER_TOKEN_KEYS', 'HOLD_PASSENGER_TOKEN_ACTIVE_VERSION')
  .or('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE');
