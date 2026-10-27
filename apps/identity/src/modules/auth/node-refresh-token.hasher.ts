import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { tokenGraceSecretFromEnv } from '../../config/token-settings.js';

const VERSION = 'v1';

/**
 * Refresh tokens are opaque random bytes; only their SHA-256 hash is stored.
 * The 10-second grace successor pair is sealed with AES-256-GCM so a database
 * reader cannot lift a usable token out of the row.
 */
@Injectable()
export class NodeRefreshTokenHasher {
  private readonly key = createHash('sha256')
    .update(tokenGraceSecretFromEnv())
    .digest();

  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  seal(payload: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  open<T>(sealed: string): T {
    const [version, ivPart, tagPart, ciphertextPart] = sealed.split('.');
    if (version !== VERSION || !ivPart || !tagPart || !ciphertextPart) {
      throw new Error('Unsupported sealed payload');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as T;
  }
}
