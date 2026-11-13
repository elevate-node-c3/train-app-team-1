import { ErrorCode } from '@app/contracts';
import { normalizeDigits } from './arabic-digits.js';

export interface PhoneValidationResult {
  valid: boolean;
  normalized: string;
  error?: ErrorCode;
}

const VALID_MOBILE_PREFIXES = ['010', '011', '012', '015'];

/**
 * Normalizes and formats Egyptian mobile phone numbers (BR-10).
 *
 * Canonical form is 11 digits: '01XXXXXXXXX'.
 * Accepts variations:
 * - '01001234567'
 * - '+201001234567'
 * - '00201001234567'
 * - '1001234567' (missing leading 0 from fixed +20 UI)
 * - Arabic digits
 * - Formatting characters (spaces, dashes, parentheses)
 */
export function normalizePhone(raw: string): PhoneValidationResult {
  if (!raw || typeof raw !== 'string') {
    return {
      valid: false,
      normalized: '',
      error: ErrorCode.INVALID_PHONE_FORMAT,
    };
  }

  // 1. Convert Arabic digits
  let cleaned = normalizeDigits(raw.trim());

  // 2. Remove all non-digit characters except leading '+'
  cleaned = cleaned.replace(/[\s\-\(\)\.]/g, '');

  // 3. Strip international prefix
  if (cleaned.startsWith('+20')) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('0020')) {
    cleaned = cleaned.slice(4);
  } else if (cleaned.startsWith('20') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  }

  // 4. If it starts with '10', '11', '12', '15' and has 10 digits, prepend '0'
  if (
    cleaned.length === 10 &&
    (cleaned.startsWith('10') ||
      cleaned.startsWith('11') ||
      cleaned.startsWith('12') ||
      cleaned.startsWith('15'))
  ) {
    cleaned = `0${cleaned}`;
  }

  // 5. Must now be 11 digits starting with 010, 011, 012, or 015
  if (!/^\d{11}$/.test(cleaned)) {
    return {
      valid: false,
      normalized: cleaned,
      error: ErrorCode.INVALID_PHONE_FORMAT,
    };
  }

  const prefix = cleaned.slice(0, 3);
  if (!VALID_MOBILE_PREFIXES.includes(prefix)) {
    return {
      valid: false,
      normalized: cleaned,
      error: ErrorCode.INVALID_PHONE_FORMAT,
    };
  }

  return {
    valid: true,
    normalized: cleaned,
  };
}
