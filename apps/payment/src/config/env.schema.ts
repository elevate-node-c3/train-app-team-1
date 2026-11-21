import Joi from 'joi';
import { commonEnvSchema } from '@app/common/config/env.schema.js';

export const paymentEnvSchema = commonEnvSchema
  .keys({
    STRIPE_SECRET_KEY: Joi.string()
      .pattern(/^sk_(test|live)_[a-zA-Z0-9]+$/)
      .required()
      .messages({
        'any.required':
          "Missing required environment variable 'STRIPE_SECRET_KEY'",
        'string.pattern.base':
          "Variable 'STRIPE_SECRET_KEY' must be a valid Stripe secret key (starting with sk_test_ or sk_live_)",
      }),
    STRIPE_PUBLISHABLE_KEY: Joi.string()
      .pattern(/^pk_(test|live)_[a-zA-Z0-9]+$/)
      .optional(),
    PUBLISHABLE_KEY: Joi.string()
      .pattern(/^pk_(test|live)_[a-zA-Z0-9]+$/)
      .optional(),
    STRIPE_WEBHOOK_SECRET: Joi.string()
      .pattern(/^whsec_[a-zA-Z0-9]+$/)
      .required()
      .messages({
        'any.required':
          "Missing required environment variable 'STRIPE_WEBHOOK_SECRET'",
        'string.pattern.base':
          "Variable 'STRIPE_WEBHOOK_SECRET' must be a valid Stripe webhook secret (starting with whsec_)",
      }),
  })
  .or('STRIPE_PUBLISHABLE_KEY', 'PUBLISHABLE_KEY')
  .messages({
    'object.missing':
      "Missing required environment variable 'STRIPE_PUBLISHABLE_KEY'",
  });
