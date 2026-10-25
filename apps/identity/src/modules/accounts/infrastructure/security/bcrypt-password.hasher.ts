import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { PASSWORD_MAX_BYTES } from '@app/contracts';
import type { PasswordHasherPort } from '../../application/ports/password-hasher.port.js';

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
function resolveCost(): number {
  const configured = Number(process.env.BCRYPT_COST ?? 12);
  return Number.isInteger(configured) && configured >= 4 && configured <= 15
    ? configured
    : 12;
}

@Injectable()
export class BcryptPasswordHasher implements PasswordHasherPort {
  private readonly cost = resolveCost();

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
