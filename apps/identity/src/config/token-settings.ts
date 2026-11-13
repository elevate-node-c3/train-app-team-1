import { TOKEN_DEFAULTS } from '@app/contracts';
import { VERIFICATION_CODE_DEFAULTS } from '@app/common/config/env.defaults.js';
import type { TokenSettings } from '../modules/auth/token-settings.js';

/** Startup validates these values; fallbacks also support tests and migrations. */
export function tokenSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenSettings {
  return {
    accessTtlSeconds: positiveInt(
      env.ACCESS_TOKEN_TTL_SECONDS,
      TOKEN_DEFAULTS.accessTtlSeconds,
    ),
    refreshTtlSeconds: positiveInt(
      env.REFRESH_TOKEN_TTL_SECONDS,
      TOKEN_DEFAULTS.refreshTtlSeconds,
    ),
    refreshGraceSeconds: nonNegativeInt(
      env.REFRESH_TOKEN_GRACE_SECONDS,
      TOKEN_DEFAULTS.refreshGraceSeconds,
    ),
    verificationCodeTtlSeconds: positiveInt(
      env.VERIFICATION_CODE_TTL_SECONDS,
      VERIFICATION_CODE_DEFAULTS.ttlSeconds,
    ),
  };
}

/**
 * Seal grace payloads with TOKEN_GRACE_SECRET, then JWT_PRIVATE_KEY if absent.
 * The final fallback is for development only.
 */
export function tokenGraceSecretFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.TOKEN_GRACE_SECRET ??
    env.JWT_PRIVATE_KEY ??
    'train-app-development-grace-secret'
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
