import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { PASSWORD_MAX_BYTES } from '@app/contracts';
import { bcryptCostFromEnv } from '../../config/password-settings.js';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * bcryptjs runs in Alpine without a native compiler, but is slower.
 * Reject inputs over 72 bytes when hashing or verifying; bcrypt truncates them.
 */
@Injectable()
export class BcryptPasswordHasher {
  private readonly cost = bcryptCostFromEnv();

  async hash(plaintext: string): Promise<string> {
    if (byteLength(plaintext) > PASSWORD_MAX_BYTES) {
      throw new Error(
        `Password exceeds bcrypt's ${PASSWORD_MAX_BYTES}-byte input limit`,
      );
    }
    return hash(plaintext, this.cost);
  }

  async verify(plaintext: string, hashValue: string): Promise<boolean> {
    if (byteLength(plaintext) > PASSWORD_MAX_BYTES) {
      return false;
    }
    return compare(plaintext, hashValue);
  }
}
