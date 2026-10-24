import type { IsStrongPasswordOptions } from 'class-validator';

/**
 * Password strength rules (BR-02), applied with class-validator's built-in
 * @IsStrongPassword on every DTO that sets a password (sign-up and reset).
 */
export const PASSWORD_POLICY: IsStrongPasswordOptions = {
  minLength: 8,
  minLowercase: 1,
  minUppercase: 1,
  minNumbers: 1,
  minSymbols: 1,
};

/** bcrypt ignores everything past 72 bytes, so longer passwords are refused. */
export const PASSWORD_MAX_BYTES = 72;

/** bcrypt cost for every password hash. */
export const BCRYPT_SALT_ROUNDS = 10;
