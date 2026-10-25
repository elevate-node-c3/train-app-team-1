import {
  decodeProtectedHeader,
  errors,
  importSPKI,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  TOKEN_DEFAULTS,
  type AccessTokenClaims,
} from '@app/contracts';
import {
  AccessTokenVerificationError,
  assertClaims,
} from './access-token.claims.js';

type PublicKey = Awaited<ReturnType<typeof importSPKI>>;

export interface JwtVerificationKey {
  kid: string;
  publicKeyPem: string;
}

export interface JwtVerifierConfig {
  active: JwtVerificationKey;
  /** Kept so a token minted just before a rotation still verifies. */
  previous?: JwtVerificationKey;
  issuer?: string;
  audience?: string;
  clockSkewSeconds?: number;
}

/**
 * Verifies with the active public key and keeps the previous one by `kid`.
 * Algorithm confusion is closed twice: `jose` is told RS256 only, and the
 * header is checked before a key is selected.
 */
export class JwtAccessTokenVerifier {
  private readonly keys = new Map<string, PublicKey>();

  private constructor(
    keys: ReadonlyMap<string, PublicKey>,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly clockSkewSeconds: number,
  ) {
    this.keys = new Map(keys);
  }

  static async create(
    config: JwtVerifierConfig,
  ): Promise<JwtAccessTokenVerifier> {
    const keys = new Map<string, PublicKey>();
    for (const entry of [config.active, config.previous]) {
      if (!entry) continue;
      keys.set(
        entry.kid,
        await importSPKI(entry.publicKeyPem, JWT_ALGORITHM),
      );
    }

    return new JwtAccessTokenVerifier(
      keys,
      config.issuer ?? JWT_ISSUER,
      config.audience ?? JWT_AUDIENCE,
      config.clockSkewSeconds ?? TOKEN_DEFAULTS.clockSkewSeconds,
    );
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    let kid: string;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== JWT_ALGORITHM) {
        throw new AccessTokenVerificationError(
          'invalid',
          'Only RS256 tokens are accepted',
        );
      }
      if (header.typ !== 'JWT') {
        throw new AccessTokenVerificationError(
          'invalid',
          'The token type is not JWT',
        );
      }
      if (typeof header.kid !== 'string' || header.kid.length === 0) {
        throw new AccessTokenVerificationError(
          'invalid',
          'The token has no key id',
        );
      }
      kid = header.kid;
    } catch (error: unknown) {
      if (error instanceof AccessTokenVerificationError) throw error;
      throw new AccessTokenVerificationError('invalid', 'Malformed token');
    }

    const key = this.keys.get(kid);
    if (!key) {
      throw new AccessTokenVerificationError('invalid', 'Unknown key id');
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, key, {
        algorithms: [JWT_ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockSkewSeconds,
        typ: 'JWT',
      });
      payload = verified.payload;
    } catch (error: unknown) {
      if (error instanceof errors.JWTExpired) {
        throw new AccessTokenVerificationError('expired', 'Token expired');
      }
      throw new AccessTokenVerificationError(
        'invalid',
        'Token verification failed',
      );
    }

    return assertClaims(payload);
  }
}
