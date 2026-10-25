import Joi from 'joi';
import { TOKEN_DEFAULTS } from '@app/contracts';
import { commonEnvSchema } from '@app/common/config/env.schema.js';
import {
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import { MAX_RELAY_POLL_INTERVAL_MS } from '@app/messaging/retry-budget.js';

/** The producer's outbox knobs. Identity owns them; no other service relays. */
export const identityEnvSchema = commonEnvSchema.keys({
  OUTBOX_RELAY_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(OUTBOX_DEFAULTS.enabled),
  // A derived upper bound, not a re-sum of the whole budget: the poll interval
  // is the only term identity owns, and the consumer's timeout and delays
  // never reach this process.
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
  // The cap enforces "a code in a dead-lettered message dies within ten
  // minutes". Do not raise it.
  VERIFICATION_CODE_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(600)
    .default(VERIFICATION_CODE_DEFAULTS.ttlSeconds)
    .messages({
      'number.max':
        "Variable 'VERIFICATION_CODE_TTL_SECONDS' must be <= 600: a verification code must die within ten minutes",
    }),
  // Identity is the only holder of the signing key. At least one of the inline
  // value and the file path is required: there is no committed fallback.
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
}).or('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_FILE');
