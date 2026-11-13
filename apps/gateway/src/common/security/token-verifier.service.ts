import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtAccessTokenVerifier } from '@app/common';
import type { AccessTokenClaims } from '@app/contracts';
import { jwtVerificationSettingsFromEnv } from '../../config/security-settings.js';

/**
 * Verify with public keys only; kid chooses the key during rotation.
 * Read keys at startup so module tests need no environment values.
 * Normal startup rejects missing keys.
 */
@Injectable()
export class TokenVerifierService implements OnModuleInit {
  private readonly logger = new Logger(TokenVerifierService.name);
  private verifier: JwtAccessTokenVerifier | null = null;

  async onModuleInit(): Promise<void> {
    const settings = jwtVerificationSettingsFromEnv();
    if (!settings) {
      // Degrade readiness and return 401 for authenticated requests instead of crashing.
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
