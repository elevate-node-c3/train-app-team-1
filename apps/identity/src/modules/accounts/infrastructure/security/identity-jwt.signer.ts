import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JwtAccessTokenSigner } from '@app/common';
import type { StaffRole } from '@app/contracts';
import type {
  AccessTokenSignerPort,
  SignedAccessToken,
} from '../../application/ports/access-token-signer.port.js';
import {
  TOKEN_SETTINGS,
  type TokenSettings,
} from '../../application/token-settings.js';

/**
 * Identity owns the only private key. Nothing else can mint an access token.
 */
@Injectable()
export class IdentityJwtSigner
  implements AccessTokenSignerPort, OnModuleInit
{
  private readonly logger = new Logger(IdentityJwtSigner.name);
  private signer: JwtAccessTokenSigner | null = null;

  constructor(
    @Inject(TOKEN_SETTINGS)
    private readonly tokens: TokenSettings,
  ) {}

  async onModuleInit(): Promise<void> {
    const pem = readPrivateKeyPem();
    this.signer = await JwtAccessTokenSigner.create({
      kid: process.env.JWT_KEY_ID ?? 'dev-1',
      privateKeyPem: pem,
      accessTtlSeconds: this.accessTtlSeconds,
    });
    this.logger.log(`JWT signer ready with key ${this.signer.keyId}`);
  }

  async sign(input: {
    accountId: string;
    level: import('@app/contracts').AccessLevel;
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

/**
 * The key is deployment input, never a shared-library default. A missing
 * variable and a missing file both name the variable to fix.
 */
function readPrivateKeyPem(): string {
  const inline = process.env.JWT_PRIVATE_KEY;
  if (inline && inline.trim().length > 0) {
    return inline.replace(/\\n/g, '\n');
  }

  const file = process.env.JWT_PRIVATE_KEY_FILE;
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
