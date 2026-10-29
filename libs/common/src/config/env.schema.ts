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

/**
 * What every service needs to boot. A service's own variables live with that
 * service: a library shared by all seven has no business enumerating one
 * service's outbox knobs or another's SMTP host, and reaching for
 * `@app/messaging` to validate them is what made the two libraries mutually
 * dependent.
 */
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
