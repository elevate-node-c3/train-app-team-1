import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOKEN_DEFAULTS } from '@app/contracts';

export interface JwtVerificationKey {
  kid: string;
  publicKeyPem: string;
}

export interface JwtVerificationSettings {
  active: JwtVerificationKey;
  previous?: JwtVerificationKey;
  clockSkewSeconds: number;
}

/**
 * Composition-root parsing for the gateway's public-key-only verifier.
 *
 * Returns `null` when no key is configured so the verifier can degrade instead
 * of crashing a root-module compile. A configured but missing file is still
 * fatal: that is a deployment bug, not an absent optional setting.
 */
export function jwtVerificationSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JwtVerificationSettings | null {
  const activePem = readPublicKeyPem(
    env.JWT_PUBLIC_KEY,
    env.JWT_PUBLIC_KEY_FILE,
    'JWT_PUBLIC_KEY_FILE',
  );
  if (!activePem) return null;

  const previousPem = readPublicKeyPem(
    env.JWT_PREVIOUS_PUBLIC_KEY,
    env.JWT_PREVIOUS_PUBLIC_KEY_FILE,
    'JWT_PREVIOUS_PUBLIC_KEY_FILE',
  );
  const clockSkew = Number(env.JWT_CLOCK_SKEW_SECONDS);

  return {
    active: {
      kid: env.JWT_KEY_ID ?? 'dev-1',
      publicKeyPem: activePem,
    },
    ...(previousPem
      ? {
          previous: {
            kid: env.JWT_PREVIOUS_KEY_ID ?? 'dev-0',
            publicKeyPem: previousPem,
          },
        }
      : {}),
    clockSkewSeconds:
      Number.isInteger(clockSkew) && clockSkew >= 0
        ? clockSkew
        : TOKEN_DEFAULTS.clockSkewSeconds,
  };
}

/** Reads an inline PEM first, then a file. A configured but missing file is fatal. */
function readPublicKeyPem(
  inline: string | undefined,
  file: string | undefined,
  fileVariable: string,
): string | null {
  if (inline && inline.trim().length > 0) {
    return inline.replace(/\\n/g, '\n');
  }
  if (!file) return null;

  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(
      `${fileVariable} points to a missing public key file: ${file}`,
    );
  }
  return readFileSync(path, 'utf8');
}
