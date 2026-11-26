import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  CompactSign,
  SignJWT,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  jwtVerify,
  type JWSHeaderParameters,
} from 'jose';
import {
  TICKET_QR_TYPE,
  TICKET_SHARE_TYPE,
  TICKET_SIGNING_ALGORITHM,
  type TicketQrClaims,
  type VerificationKey,
} from '@app/contracts';

import {
  ticketSigningSettingsFromEnv,
  type TicketSigningSettings,
} from '../../../config/ticket-signing-settings.js';
import { isTicketQrClaims } from '../ticket-snapshot.js';

export type QrVerification =
  | { status: 'valid'; keyId: string; claims: TicketQrClaims }
  | { status: 'malformed' }
  | { status: 'invalid-signature' };

/**
 * The only holder of the ticket signing key (BR-38, D11).
 *
 * Both the QR and the share link are compact JWS over Ed25519, each naming its
 * key in `kid` and its purpose in `typ`, so a share token can never pass for a
 * QR or the reverse. Verification picks the public key by `kid`, which is what
 * keeps tickets signed before a rotation valid while that key is retained.
 */
@Injectable()
export class TicketSignerService implements OnModuleInit {
  private signingKey: KeyObject | null = null;
  private activeKeyId = '';
  private readonly verificationKeys = new Map<string, KeyObject>();

  /** Fails the boot, as identity's JWT key does: no key, no tickets. */
  onModuleInit(): void {
    this.load(ticketSigningSettingsFromEnv());
  }

  load(settings: TicketSigningSettings): void {
    const privateKey = createPrivateKey(settings.privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('The ticket signing key must be an Ed25519 private key');
    }
    this.verificationKeys.clear();
    for (const retired of settings.retiredPublicKeys) {
      const publicKey = createPublicKey(retired.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Retired ticket key ${retired.kid} is not Ed25519`);
      }
      this.verificationKeys.set(retired.kid, publicKey);
    }
    this.verificationKeys.set(settings.keyId, createPublicKey(privateKey));
    this.signingKey = privateKey;
    this.activeKeyId = settings.keyId;
  }

  get keyId(): string {
    return this.activeKeyId;
  }

  /** The key a stored QR was signed with, which may predate a rotation. */
  keyIdOf(qr: string): string {
    const { kid } = decodeProtectedHeader(qr);
    return typeof kid === 'string' ? kid : '';
  }

  async signQr(claims: TicketQrClaims): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
      .setProtectedHeader(this.header(TICKET_QR_TYPE))
      .sign(this.key());
  }

  /** Signature first; only then is the payload's shape worth reading. */
  async verifyQr(qr: string): Promise<QrVerification> {
    if (!isCanonical(qr)) return { status: 'malformed' };
    let header: JWSHeaderParameters;
    try {
      header = decodeProtectedHeader(qr);
    } catch {
      return { status: 'malformed' };
    }
    if (
      header.alg !== TICKET_SIGNING_ALGORITHM ||
      header.typ !== TICKET_QR_TYPE ||
      typeof header.kid !== 'string'
    ) {
      return { status: 'malformed' };
    }

    const publicKey = this.verificationKeys.get(header.kid);
    if (!publicKey) return { status: 'invalid-signature' };

    let payload: Uint8Array;
    try {
      ({ payload } = await compactVerify(qr, publicKey, {
        algorithms: [TICKET_SIGNING_ALGORITHM],
      }));
    } catch {
      return { status: 'invalid-signature' };
    }

    let claims: unknown;
    try {
      claims = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return { status: 'malformed' };
    }
    return isTicketQrClaims(claims)
      ? { status: 'valid', keyId: header.kid, claims }
      : { status: 'malformed' };
  }

  /** One ticket, nothing else, until the passenger arrives (BR-39). */
  async signShareToken(ticketId: string, expiresAt: Date): Promise<string> {
    return new SignJWT({})
      .setSubject(ticketId)
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setProtectedHeader(this.header(TICKET_SHARE_TYPE))
      .sign(this.key());
  }

  /** The ticket a share token names, or null for anything altered or expired. */
  async verifyShareToken(token: string): Promise<string | null> {
    if (!isCanonical(token)) return null;
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const publicKey =
            typeof header.kid === 'string'
              ? this.verificationKeys.get(header.kid)
              : undefined;
          if (!publicKey) throw new Error('Unknown ticket key');
          return publicKey;
        },
        { algorithms: [TICKET_SIGNING_ALGORITHM], typ: TICKET_SHARE_TYPE },
      );
      return typeof payload.sub === 'string' && payload.exp !== undefined
        ? payload.sub
        : null;
    } catch {
      return null;
    }
  }

  /** What an offline scanner needs: every retained public key, none private. */
  async verificationKeySet(): Promise<VerificationKey[]> {
    const keys: VerificationKey[] = [];
    for (const [kid, publicKey] of this.verificationKeys) {
      const jwk = await exportJWK(publicKey);
      keys.push({
        kid,
        kty: 'OKP',
        crv: 'Ed25519',
        x: jwk.x ?? '',
        alg: TICKET_SIGNING_ALGORITHM,
      });
    }
    return keys;
  }

  private header(typ: string): JWSHeaderParameters & { alg: string } {
    return { alg: TICKET_SIGNING_ALGORITHM, kid: this.activeKeyId, typ };
  }

  private key(): KeyObject {
    if (!this.signingKey) {
      throw new Error('The ticket signing key has not been loaded');
    }
    return this.signingKey;
  }
}

/**
 * Exactly what was signed, character for character. A segment's last
 * base64url character can carry unused bits that decoders ignore, so an edit
 * there would otherwise still verify; any change at all is refused instead.
 */
function isCanonical(compact: string): boolean {
  const segments = compact.split('.');
  return (
    segments.length === 3 &&
    segments.every(
      (segment) =>
        /^[\w-]+$/.test(segment) &&
        Buffer.from(segment, 'base64url').toString('base64url') === segment,
    )
  );
}
