import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtAccessTokenVerifier } from '@app/common';
import type { AccessTokenClaims } from '@app/contracts';
import { jwtVerificationSettingsFromEnv } from '../../config/security-settings.js';

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
export class TokenVerifierService implements OnModuleInit {
  private readonly logger = new Logger(TokenVerifierService.name);
  private verifier: JwtAccessTokenVerifier | null = null;

  async onModuleInit(): Promise<void> {
    const settings = jwtVerificationSettingsFromEnv();
    if (!settings) {
      // Degrade rather than crash: readiness reports it and every
      // authenticated request answers 401 instead of the process dying.
      this.logger.error(
        "No 'JWT_PUBLIC_KEY' or 'JWT_PUBLIC_KEY_FILE' configured; no token can be verified",
      );
      return;
    }

    this.verifier = await JwtAccessTokenVerifier.create(settings);
    this.logger.log('JWT verifier ready');
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    if (!this.verifier) {
      throw new Error('JWT verifier is not initialised');
    }
    return this.verifier.verify(token);
  }
}
