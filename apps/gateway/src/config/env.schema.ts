import Joi from 'joi';
import { commonEnvSchema } from '@app/common/config/env.schema.js';

/** The gateway is the only service that calls the other six. */
export const gatewayEnvSchema = commonEnvSchema.keys({
  CATALOG_GRPC_URL: Joi.string().default('catalog:50051'),
  IDENTITY_GRPC_URL: Joi.string().default('identity:50051'),
  INVENTORY_GRPC_URL: Joi.string().default('inventory:50051'),
  BOOKING_GRPC_URL: Joi.string().default('booking:50051'),
  PAYMENT_GRPC_URL: Joi.string().default('payment:50051'),
  NOTIFICATION_GRPC_URL: Joi.string().default('notification:50051'),
});
