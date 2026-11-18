import { describe, expect, it } from 'vitest';
import { matchesServiceCredential } from './service-credential.js';

describe('purpose-specific internal service credentials', () => {
  const key = 'test-service-credential-32-characters-long';
  it('accepts only the configured credential', () => {
    expect(matchesServiceCredential(key, key)).toBe(true);
    expect(matchesServiceCredential('x'.repeat(key.length), key)).toBe(false);
  });
  it.each([
    undefined,
    null,
    '',
    'short',
    ['repeated', 'header'],
    Buffer.from(key),
  ])('refuses missing, malformed, or duplicated metadata', (actual) => {
    expect(matchesServiceCredential(actual, key)).toBe(false);
  });
  it('does not permit an unconfigured or weak service key', () => {
    expect(matchesServiceCredential('', undefined)).toBe(false);
    expect(matchesServiceCredential('short', 'short')).toBe(false);
  });
});
