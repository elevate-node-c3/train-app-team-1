import type { ObjectSchema } from 'joi';
import { SECRET_KEYS } from './env.schema.js';

export class ConfigurationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationException';
  }
}

/**
 * Throws ConfigurationException for invalid variables, naming each variable
 * and redacting secret values.
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
    // Joi may include secret values in its error text.
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

/** On invalid boot settings, print diagnostics to stderr and exit with code 1. */
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
