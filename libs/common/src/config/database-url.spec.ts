import { describe, expect, it } from 'vitest';

import { databaseUrlFromEnv } from './database-url.js';

describe('databaseUrlFromEnv', () => {
  it('returns the configured URL', () => {
    expect(
      databaseUrlFromEnv({
        DATABASE_URL: 'postgres://catalog:secret@db:5432/catalog',
      }),
    ).toBe('postgres://catalog:secret@db:5432/catalog');
  });

  it('trims surrounding whitespace a compose file can introduce', () => {
    expect(
      databaseUrlFromEnv({ DATABASE_URL: '  postgres://db:5432/x  ' }),
    ).toBe('postgres://db:5432/x');
  });

  // No fallback: a service with no DATABASE_URL must refuse to start rather
  // than invent local credentials and talk to the wrong database.
  it('refuses a missing variable', () => {
    expect(() => databaseUrlFromEnv({})).toThrowError(
      "Missing required environment variable 'DATABASE_URL'",
    );
  });

  it('refuses a blank variable', () => {
    expect(() => databaseUrlFromEnv({ DATABASE_URL: '   ' })).toThrowError(
      "Missing required environment variable 'DATABASE_URL'",
    );
  });

  it('reads process.env when no environment is passed', () => {
    expect(databaseUrlFromEnv()).toBe(process.env.DATABASE_URL);
  });
});
