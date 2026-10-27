import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface JwtSigningSettings {
  keyId: string;
  privateKeyPem: string;
}

/**
 * The key is deployment input, never a shared-library default. A missing
 * variable and a missing file both name the variable to fix. Read lazily from
 * `onModuleInit` so compiling the module never requires a key.
 */
export function jwtSigningSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JwtSigningSettings {
  return {
    keyId: env.JWT_KEY_ID ?? 'dev-1',
    privateKeyPem: privateKeyPemFromEnv(env),
  };
}

function privateKeyPemFromEnv(env: NodeJS.ProcessEnv): string {
  const inline = env.JWT_PRIVATE_KEY;
  if (inline && inline.trim().length > 0) {
    return inline.replace(/\\n/g, '\n');
  }

  const file = env.JWT_PRIVATE_KEY_FILE;
  if (!file) {
    throw new Error(
      "Missing required environment variable 'JWT_PRIVATE_KEY' or 'JWT_PRIVATE_KEY_FILE'",
    );
  }

  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(
      `JWT_PRIVATE_KEY_FILE points to a missing private key file: ${file}`,
    );
  }
  return readFileSync(path, 'utf8');
}
