import Joi from 'joi';

export const SECRET_KEYS = new Set([
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'RABBITMQ_PASSWORD',
  'CATALOG_DB_PASSWORD',
  'GATEWAY_DB_PASSWORD',
  'IDENTITY_DB_PASSWORD',
  'INVENTORY_DB_PASSWORD',
  'BOOKING_DB_PASSWORD',
  'PAYMENT_DB_PASSWORD',
  'NOTIFICATION_DB_PASSWORD',
]);

export const commonEnvSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).required().messages({
    'number.base': "Variable 'PORT' must be a valid integer port",
    'number.min': "Variable 'PORT' must be >= 1",
    'number.max': "Variable 'PORT' must be <= 65535",
    'any.required': "Missing required environment variable 'PORT'",
  }),
  GRPC_PORT: Joi.number().integer().min(1).max(65535).default(50051),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required()
    .messages({
      'string.uriCustomScheme':
        "Variable 'DATABASE_URL' must have scheme postgres:// or postgresql://",
      'string.uri': "Variable 'DATABASE_URL' must be a valid URL",
      'any.required': "Missing required environment variable 'DATABASE_URL'",
    }),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis'] })
    .required()
    .messages({
      'string.uriCustomScheme':
        "Variable 'REDIS_URL' must have scheme redis://",
      'string.uri': "Variable 'REDIS_URL' must be a valid URL",
      'any.required': "Missing required environment variable 'REDIS_URL'",
    }),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required()
    .messages({
      'string.uriCustomScheme':
        "Variable 'RABBITMQ_URL' must have scheme amqp:// or amqps://",
      'string.uri': "Variable 'RABBITMQ_URL' must be a valid URL",
      'any.required': "Missing required environment variable 'RABBITMQ_URL'",
    }),
}).unknown(true);

export const notificationEnvSchema = commonEnvSchema.keys({
  SMTP_HOST: Joi.string().required().messages({
    'any.required': "Missing required environment variable 'SMTP_HOST'",
  }),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).required().messages({
    'number.base': "Variable 'SMTP_PORT' must be a valid integer port",
    'any.required': "Missing required environment variable 'SMTP_PORT'",
  }),
});

export const gatewayEnvSchema = commonEnvSchema.keys({
  CATALOG_GRPC_URL: Joi.string().default('catalog:50051'),
  IDENTITY_GRPC_URL: Joi.string().default('identity:50051'),
  INVENTORY_GRPC_URL: Joi.string().default('inventory:50051'),
  BOOKING_GRPC_URL: Joi.string().default('booking:50051'),
  PAYMENT_GRPC_URL: Joi.string().default('payment:50051'),
  NOTIFICATION_GRPC_URL: Joi.string().default('notification:50051'),
});
