import { describe, expect, it } from 'vitest';
import { STAFF_SEED_ACCOUNTS } from './staff-accounts.js';
import { seedPassword } from './staff-accounts.seed.js';

const [operator, conductor] = STAFF_SEED_ACCOUNTS;

describe('staff account seed password resolution', () => {
  it("uses the account's environment variable when it is set", () => {
    expect(
      seedPassword(operator, {
        NODE_ENV: 'production',
        OPERATOR_SEED_PASSWORD: 'from-the-environment',
      }),
    ).toBe('from-the-environment');
  });

  it('falls back to the development password outside production', () => {
    expect(seedPassword(operator, { NODE_ENV: 'test' })).toBe(
      operator.developmentPassword,
    );
  });

  it('refuses to seed in production without the password variable', () => {
    expect(() => seedPassword(operator, { NODE_ENV: 'production' })).toThrowError(
      /OPERATOR_SEED_PASSWORD/,
    );
    expect(() =>
      seedPassword(conductor, { NODE_ENV: 'production' }),
    ).toThrowError(/CONDUCTOR_SEED_PASSWORD/);
  });
});
