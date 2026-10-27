import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtAccessTokenSigner } from '@app/common';
import type { AccessLevel, StaffRole } from '@app/contracts';
import { jwtSigningSettingsFromEnv } from '../../config/jwt-settings.js';
import { TOKEN_SETTINGS, type TokenSettings } from './token-settings.js';

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Identity owns the only private key. Nothing else can mint an access token.
 */
@Injectable()
export class IdentityJwtSigner implements OnModuleInit {
  private readonly logger = new Logger(IdentityJwtSigner.name);
  private signer: JwtAccessTokenSigner | null = null;

  constructor(
    @Inject(TOKEN_SETTINGS)
    private readonly tokens: TokenSettings,
  ) {}

  async onModuleInit(): Promise<void> {
    const settings = jwtSigningSettingsFromEnv();
    this.signer = await JwtAccessTokenSigner.create({
      kid: settings.keyId,
      privateKeyPem: settings.privateKeyPem,
      accessTtlSeconds: this.accessTtlSeconds,
    });
    this.logger.log(`JWT signer ready with key ${this.signer.keyId}`);
  }

  async sign(input: {
    accountId: string;
    level: AccessLevel;
    roles: StaffRole[];
    sessionId: string;
    bookable: boolean;
    now: Date;
  }): Promise<SignedAccessToken> {
    if (!this.signer) {
      throw new Error('JWT signer is not initialised');
    }
    const { token, claims } = await this.signer.sign({
      sub: input.accountId,
      lvl: input.level,
      roles: input.roles,
      sid: input.sessionId,
      bkbl: input.bookable,
      now: input.now,
    });
    return { token, expiresAt: new Date(claims.exp * 1000) };
  }

  get accessTtlSeconds(): number {
    return this.tokens.accessTtlSeconds;
  }
}
