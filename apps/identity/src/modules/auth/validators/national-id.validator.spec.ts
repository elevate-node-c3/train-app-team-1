import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { validateNationalId } from './national-id.validator.js';

describe('validateNationalId', () => {
  const referenceNow = new Date('2026-10-28T12:00:00.000Z');

  it('accepts valid 14-digit Egyptian ID with century 2 (1900s)', () => {
    // Born 1985-05-15, Cairo (01), sequence 1234, check 5
    const result = validateNationalId('28505150101235', referenceNow);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalized).toBe('28505150101235');
  });

  it('accepts valid 14-digit Egyptian ID with century 3 (2000s)', () => {
    // Born 2002-11-20, Giza (21), sequence 5678, check 9
    const result = validateNationalId('30211202105679', referenceNow);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('normalizes Arabic digits to Western digits', () => {
    // 28505150101235 in Arabic digits
    const arabic = '٢٨٥٠٥١٥٠١٠١٢٣٥';
    const result = validateNationalId(arabic, referenceNow);
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe('28505150101235');
  });

  it('rejects design sample 26582264865 with INVALID_NATIONAL_ID_LENGTH (11 digits)', () => {
    const result = validateNationalId('26582264865', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([ErrorCode.INVALID_NATIONAL_ID_LENGTH]);
  });

  it('rejects ID with invalid century digit', () => {
    const result = validateNationalId('18505150101235', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_CENTURY);
  });

  it('rejects February 31 birth date with INVALID_NATIONAL_ID_BIRTH_DATE', () => {
    const result = validateNationalId('28502310101235', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE);
  });

  it('rejects future birth date in the same year with INVALID_NATIONAL_ID_BIRTH_DATE', () => {
    // 2026-11-15 is after referenceNow 2026-10-28
    const result = validateNationalId('32611150101235', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE);
  });

  it('rejects unknown governorate code 99 with INVALID_NATIONAL_ID_GOVERNORATE', () => {
    const result = validateNationalId('28505159901235', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE);
  });

  it('accumulates multiple errors when both birth date and governorate are invalid', () => {
    // Feb 31 and gov 99
    const result = validateNationalId('28502319901235', referenceNow);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE);
    expect(result.errors).toContain(ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE);
  });
});
