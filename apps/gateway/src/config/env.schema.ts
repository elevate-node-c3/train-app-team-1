import Joi from 'joi';
import { TOKEN_DEFAULTS } from '@app/contracts';
import { commonEnvSchema } from '@app/common/config/env.schema.js';

/** The gateway is the only service that calls the other six. */
export const gatewayEnvSchema = commonEnvSchema.keys({
  CATALOG_GRPC_URL: Joi.string().default('catalog:50051'),
  IDENTITY_GRPC_URL: Joi.string().default('identity:50051'),
  INVENTORY_GRPC_URL: Joi.string().default('inventory:50051'),
  BOOKING_GRPC_URL: Joi.string().default('booking:50051'),
  PAYMENT_GRPC_URL: Joi.string().default('payment:50051'),
  NOTIFICATION_GRPC_URL: Joi.string().default('notification:50051'),

  // Public-key only: the gateway can verify an access token but cannot mint
  // one. The previous key is optional and makes a rotation zero-downtime.
  JWT_KEY_ID: Joi.string().default('dev-1'),
  JWT_PUBLIC_KEY: Joi.string().optional(),
  JWT_PUBLIC_KEY_FILE: Joi.string().optional(),
  JWT_PREVIOUS_KEY_ID: Joi.string().optional(),
  JWT_PREVIOUS_PUBLIC_KEY: Joi.string().optional(),
  JWT_PREVIOUS_PUBLIC_KEY_FILE: Joi.string().optional(),
  JWT_CLOCK_SKEW_SECONDS: Joi.number()
    .integer()
    .min(0)
    .max(60)
    .default(TOKEN_DEFAULTS.clockSkewSeconds),
}).or('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_FILE');
