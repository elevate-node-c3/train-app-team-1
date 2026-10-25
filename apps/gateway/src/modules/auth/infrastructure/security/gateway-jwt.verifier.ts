import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JwtAccessTokenVerifier } from '@app/common';
import { TOKEN_DEFAULTS, type AccessTokenClaims } from '@app/contracts';
import type { AccessTokenVerifierPort } from '../../application/ports/access-token-verifier.port.js';

/**
 * Verification is public-key only: the gateway cannot mint a token even if it
 * wanted to. The previous key is optional and selected by `kid`, which is what
 * makes a rotation deployable without a validation outage.
 *
 * Built in `onModuleInit`, never in the constructor or a `useFactory`. Reading
 * a key file is deployment I/O, and the skeleton test compiles every root
 * module with no environment at all — a provider that reads configuration
 * while Nest is still wiring cannot satisfy that. `validateEnv` in `main.ts`
 * is what refuses to boot when the key is missing.
 */
@Injectable()
export class GatewayJwtVerifier
  implements AccessTokenVerifierPort, OnModuleInit
{
  private readonly logger = new Logger(GatewayJwtVerifier.name);
  private verifier: JwtAccessTokenVerifier | null = null;

  async onModuleInit(): Promise<void> {
    const activePem = readPublicKeyPem(
      process.env.JWT_PUBLIC_KEY,
      process.env.JWT_PUBLIC_KEY_FILE,
      'JWT_PUBLIC_KEY_FILE',
    );
    if (!activePem) {
      // Degrade rather than crash: readiness reports it and every
      // authenticated request answers 401 instead of the process dying.
      this.logger.error(
        "No 'JWT_PUBLIC_KEY' or 'JWT_PUBLIC_KEY_FILE' configured; no token can be verified",
      );
      return;
    }

    const previousPem = readPublicKeyPem(
      process.env.JWT_PREVIOUS_PUBLIC_KEY,
      process.env.JWT_PREVIOUS_PUBLIC_KEY_FILE,
      'JWT_PREVIOUS_PUBLIC_KEY_FILE',
    );
    const clockSkew = Number(process.env.JWT_CLOCK_SKEW_SECONDS);

    this.verifier = await JwtAccessTokenVerifier.create({
      active: {
        kid: process.env.JWT_KEY_ID ?? 'dev-1',
        publicKeyPem: activePem,
      },
      ...(previousPem
        ? {
            previous: {
              kid: process.env.JWT_PREVIOUS_KEY_ID ?? 'dev-0',
              publicKeyPem: previousPem,
            },
          }
        : {}),
      clockSkewSeconds:
        Number.isInteger(clockSkew) && clockSkew >= 0
          ? clockSkew
          : TOKEN_DEFAULTS.clockSkewSeconds,
    });
    this.logger.log('JWT verifier ready');
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    if (!this.verifier) {
      throw new Error('JWT verifier is not initialised');
    }
    return this.verifier.verify(token);
  }
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
