import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { PASSWORD_MAX_BYTES } from '@app/contracts';
import { bcryptCostFromEnv } from '../../config/password-settings.js';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * bcryptjs is pure JavaScript: slower than the native binding, but it needs no
 * compiler in `node:24-alpine`, which is the difference between a reproducible
 * image and a two-stage Python/C++ toolchain.
 *
 * The 72-byte rule is enforced on the way in *and* on the way out. bcrypt
 * silently ignores everything after byte 72; accepting a longer input would
 * mean a password that is only partly checked.
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
