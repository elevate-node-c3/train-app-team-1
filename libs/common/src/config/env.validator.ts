import type { ObjectSchema } from 'joi';
import { SECRET_KEYS } from './env.schema.js';

export class ConfigurationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationException';
  }
}

/**
 * Validates environment variables against a Joi schema.
 * Throws a ConfigurationException if validation fails, naming the offending variable
 * and redacting any secret values.
 */
export function validateEnvOrThrow<T = Record<string, unknown>>(
  schema: ObjectSchema,
  env: Record<string, unknown> = process.env,
  serviceName?: string,
): T {
  const { error, value } = schema.validate(env, {
    abortEarly: false,
    allowUnknown: true,
  });

  if (!error) {
    return value as T;
  }

  const messages: string[] = [];
  const prefix = serviceName ? `[${serviceName}] ` : '';

  for (const detail of error.details) {
    const key = String(
      detail.path[0] ?? detail.context?.key ?? 'UNKNOWN_VARIABLE',
    );
    const isSecret =
      SECRET_KEYS.has(key) || /password|secret|token|key/i.test(key);

    let reason = detail.message;
    // Strip raw secret value from error message if Joi interpolated it
    if (isSecret) {
      reason = reason.replace(/"[^"]*"/g, '[REDACTED]');
    }

    if (detail.type === 'any.required') {
      messages.push(
        `${prefix}Configuration error: Missing required environment variable '${key}'`,
      );
    } else {
      const rawVal = env[key];
      const displayVal = isSecret ? '[REDACTED]' : JSON.stringify(rawVal);
      messages.push(
        `${prefix}Configuration error: Invalid variable '${key}' (${displayVal}): ${reason}`,
      );
    }
  }

  throw new ConfigurationException(messages.join('\n'));
}

/**
 * Validates environment at boot and exits the process immediately (code 1)
 * if configuration is invalid or missing, printing diagnostics to stderr.
 */
export function validateEnv<T = Record<string, unknown>>(
  schema: ObjectSchema,
  env: Record<string, unknown> = process.env,
  serviceName?: string,
): T {
  try {
    return validateEnvOrThrow<T>(schema, env, serviceName);
  } catch (err) {
    if (err instanceof ConfigurationException) {
      console.error(err.message);
      process.exit(1);
    }
    console.error('Fatal configuration error', err);
    process.exit(1);
  }
}
