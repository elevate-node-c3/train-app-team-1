import { NOTIFICATION_DEFAULTS } from '@app/common/config/env.defaults.js';

export interface SmtpSettings {
  host: string;
  port: number;
  from: string;
  handlerTimeoutMs: number;
}

/**
 * Composition-root parsing for the mailer. The values have already passed the
 * Joi schema in `main.ts`; the fallbacks keep a host-run unit test safe too.
 */
export function smtpSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SmtpSettings {
  const configuredPort = Number(env.SMTP_PORT);
  const configuredTimeout = Number(env.EVENT_HANDLER_TIMEOUT_MS);

  return {
    host: env.SMTP_HOST ?? 'localhost',
    port:
      Number.isInteger(configuredPort) && configuredPort > 0
        ? configuredPort
        : 1025,
    from: env.SMTP_FROM ?? NOTIFICATION_DEFAULTS.smtpFrom,
    handlerTimeoutMs:
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : NOTIFICATION_DEFAULTS.handlerTimeoutMs,
  };
}
