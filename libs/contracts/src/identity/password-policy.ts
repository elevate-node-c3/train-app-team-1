/**
 * Shared HTTP/identity rules. Limit passwords to 72 UTF-8 bytes because bcrypt
 * truncates longer inputs; count bytes, not characters, for that limit.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export type PasswordPolicyViolationCode =
  'required' | 'min_length' | 'max_bytes' | 'letter' | 'digit' | 'symbol';

export interface PasswordPolicyViolation {
  code: PasswordPolicyViolationCode;
  message: string;
}

export function passwordPolicyViolations(
  password: unknown,
): PasswordPolicyViolation[] {
  if (typeof password !== 'string' || password.length === 0) {
    return [
      { code: 'required', message: 'password must be a non-empty string' },
    ];
  }

  const violations: PasswordPolicyViolation[] = [];
  // Length counts Unicode code points, not UTF-16 units.
  const length = Array.from(password).length;
  const bytes = new TextEncoder().encode(password).length;

  if (length < PASSWORD_MIN_LENGTH) {
    violations.push({
      code: 'min_length',
      message: `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    });
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    violations.push({
      code: 'max_bytes',
      message: `password must be at most ${PASSWORD_MAX_BYTES} bytes (UTF-8)`,
    });
  }
  if (!/\p{L}/u.test(password)) {
    violations.push({
      code: 'letter',
      message: 'password must contain at least one letter',
    });
  }
  if (!/\d/.test(password)) {
    violations.push({
      code: 'digit',
      message: 'password must contain at least one digit',
    });
  }
  if (!/[^\p{L}\p{N}\s]/u.test(password)) {
    violations.push({
      code: 'symbol',
      message: 'password must contain at least one symbol',
    });
  }

  return violations;
}
