import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { normalizePhone } from './phone.validator.js';

describe('normalizePhone', () => {
  it('normalizes local 11-digit number', () => {
    const res = normalizePhone('01001234567');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');
  });

  it('normalizes +20 international format', () => {
    const res = normalizePhone('+201001234567');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');
  });

  it('normalizes 0020 international format', () => {
    const res = normalizePhone('00201001234567');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');
  });

  it('normalizes number without leading 0 (from fixed +20 prefix UI)', () => {
    const res = normalizePhone('1001234567');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');
  });

  it('handles spaces, dashes, and parentheses', () => {
    const res = normalizePhone('+20 100 123 4567');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');

    const res2 = normalizePhone('(011) 2345-6789');
    expect(res2.valid).toBe(true);
    expect(res2.normalized).toBe('01123456789');
  });

  it('normalizes Arabic digits', () => {
    const res = normalizePhone('٠١٠٠١٢٣٤٥٦٧');
    expect(res.valid).toBe(true);
    expect(res.normalized).toBe('01001234567');
  });

  it('accepts all valid Egyptian operator prefixes (010, 011, 012, 015)', () => {
    expect(normalizePhone('01011111111').valid).toBe(true);
    expect(normalizePhone('01111111111').valid).toBe(true);
    expect(normalizePhone('01211111111').valid).toBe(true);
    expect(normalizePhone('01511111111').valid).toBe(true);
  });

  it('rejects invalid mobile prefix (e.g. 013 landline)', () => {
    const res = normalizePhone('01311111111');
    expect(res.valid).toBe(false);
    expect(res.error).toBe(ErrorCode.INVALID_PHONE_FORMAT);
  });

  it('rejects numbers that are too short or too long', () => {
    expect(normalizePhone('0100123456').valid).toBe(false);
    expect(normalizePhone('010012345678').valid).toBe(false);
  });

  it('rejects non-numeric gibberish', () => {
    expect(normalizePhone('not-a-phone').valid).toBe(false);
  });
});
