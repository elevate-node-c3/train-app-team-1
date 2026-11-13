import { NOTIFICATION_DEFAULTS } from '@app/common/config/env.defaults.js';

export interface SmtpSettings {
  host: string;
  port: number;
  from: string;
  handlerTimeoutMs: number;
}

/** Read validated SMTP settings; defaults also support local tests. */
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
