import { existsSync, readFileSync, statSync } from 'node:fs';
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

/** No key returns null for degraded mode; a configured missing file is fatal. */
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

/** Prefers inline PEM; a configured missing key file is fatal. */
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
  if (statSync(path).isDirectory()) {
    throw new Error(
      `${fileVariable} points to a directory, not a file: ${file}. If you started Docker before generating keys, run 'npm run keys:generate' and restart Docker.`,
    );
  }
  return readFileSync(path, 'utf8');
}
