import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { validateFullName } from './full-name.validator.js';

describe('validateFullName', () => {
  it('accepts valid Arabic name with 2 or more words', () => {
    const res = validateFullName('أحمد حسين');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('أحمد حسين');

    const res2 = validateFullName('محمد علي حسن');
    expect(res2.valid).toBe(true);
    expect(res2.normalized).toBe('محمد علي حسن');
  });

  it('accepts valid Latin name with 2 or more words', () => {
    const res = validateFullName('Ahmed Hussein');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('Ahmed Hussein');
  });

  it('collapses multiple inner spaces and trims edges', () => {
    const res = validateFullName('   Ahmed     Hussein   ');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('Ahmed Hussein');
  });

  it('rejects a single name with INVALID_FULL_NAME', () => {
    const res = validateFullName('Ahmed');
    expect(res.valid).toBe(false);
    expect(res.error).toBe(ErrorCode.INVALID_FULL_NAME);
  });

  it('rejects names with numbers or symbols', () => {
    expect(validateFullName('Ahmed 123').valid).toBe(false);
    expect(validateFullName('Ahmed @ Hussein').valid).toBe(false);
    expect(validateFullName('Ahmed-Hussein').valid).toBe(false);
  });

  it('rejects names exceeding 50 characters', () => {
    const longName = 'Ahmed '.repeat(10); // 60 chars
    const res = validateFullName(longName);
    expect(res.valid).toBe(false);
    expect(res.error).toBe(ErrorCode.INVALID_FULL_NAME);
  });
});

