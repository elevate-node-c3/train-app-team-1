import Joi from 'joi';
import { commonEnvSchema } from '@app/common/config/env.schema.js';
import {
  OUTBOX_DEFAULTS,
  VERIFICATION_CODE_DEFAULTS,
} from '@app/common/config/env.defaults.js';

/** The producer's outbox knobs. Identity owns them; no other service relays. */
export const identityEnvSchema = commonEnvSchema.keys({
  OUTBOX_RELAY_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(OUTBOX_DEFAULTS.enabled),
  OUTBOX_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(1)
    .default(OUTBOX_DEFAULTS.pollIntervalMs),
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
});
