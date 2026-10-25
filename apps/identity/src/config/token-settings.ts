import { TOKEN_DEFAULTS } from '@app/contracts';
import { VERIFICATION_CODE_DEFAULTS } from '@app/common/config/env.defaults.js';
import type { TokenSettings } from '../modules/accounts/application/token-settings.js';

/**
 * Composition-root parsing. The values have already passed the Joi schema in
 * `main.ts`; these fallbacks make a host-run unit test or migration safe too.
 */
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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
