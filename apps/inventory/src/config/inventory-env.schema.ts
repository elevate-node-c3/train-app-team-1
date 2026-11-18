import Joi from 'joi';
import { commonEnvSchema } from '@app/common';

export const inventoryEnvSchema = commonEnvSchema.keys({
  HOLD_CREATION_ENABLED: Joi.boolean().default(false),
  BOOKING_INVENTORY_SERVICE_KEY: Joi.when('HOLD_CREATION_ENABLED', {
    is: true,
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).allow('').optional(),
  }),
  HOLD_EXPIRY_WORKER_ENABLED: Joi.boolean().default(true),
  HOLD_EXPIRY_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(500),
  HOLD_EXPIRY_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(1)
    .max(10_000)
    .default(250),
  OUTBOX_RELAY_ENABLED: Joi.boolean().default(true),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(100),
  OUTBOX_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(1)
    .max(10_000)
    .default(100),
  OUTBOX_PUBLISH_CONCURRENCY: Joi.number().integer().min(1).max(64).default(32),
  AMQP_PUBLISH_CONFIRM_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1)
    .max(60_000)
    .default(5000),
});
