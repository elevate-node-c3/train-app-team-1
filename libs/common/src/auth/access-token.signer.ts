import { SignJWT, importPKCS8 } from 'jose';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  TOKEN_DEFAULTS,
  type AccessTokenClaims,
} from '@app/contracts';
import {
  buildAccessTokenClaims,
  type SignAccessTokenInput,
} from './access-token.claims.js';

type PrivateKey = Awaited<ReturnType<typeof importPKCS8>>;

export interface JwtSignerConfig {
  kid: string;
  privateKeyPem: string;
  issuer?: string;
  audience?: string;
  accessTtlSeconds?: number;
}

export class JwtAccessTokenSigner {
  private constructor(
    private readonly key: PrivateKey,
    private readonly kid: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly accessTtlSeconds: number,
  ) {}

  static async create(config: JwtSignerConfig): Promise<JwtAccessTokenSigner> {
    const key = await importPKCS8(config.privateKeyPem, JWT_ALGORITHM);
    return new JwtAccessTokenSigner(
      key,
      config.kid,
      config.issuer ?? JWT_ISSUER,
      config.audience ?? JWT_AUDIENCE,
      config.accessTtlSeconds ?? TOKEN_DEFAULTS.accessTtlSeconds,
    );
  }

  async sign(input: SignAccessTokenInput): Promise<{
    token: string;
    claims: AccessTokenClaims;
  }> {
    const claims = buildAccessTokenClaims(input, {
      issuer: this.issuer,
      audience: this.audience,
      accessTtlSeconds: this.accessTtlSeconds,
    });

    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({
        alg: JWT_ALGORITHM,
        typ: 'JWT',
        kid: this.kid,
      })
      .sign(this.key);

    return { token, claims };
  }

  get keyId(): string {
    return this.kid;
  }

  get ttlSeconds(): number {
    return this.accessTtlSeconds;
  }
}
