import { ErrorCode } from '@app/contracts';

export interface FullNameValidationResult {
  valid: boolean;
  normalized: string;
  error?: ErrorCode;
}

export const MAX_FULL_NAME_LENGTH = 50;

// Arabic letters or Latin letters
const ARABIC_OR_LATIN_WORD_REGEX = /^[\u0600-\u06FFA-Za-z]+$/;

/**
 * Validates full name (BR-10).
 * - Trimmed, inner spaces collapsed
 * - At least two words (first and family name)
 * - Maximum length 50 characters
 * - Arabic or Latin letters only
 */
export function validateFullName(raw: string): FullNameValidationResult {
  if (!raw || typeof raw !== 'string') {
    return {
      valid: false,
      normalized: '',
      error: ErrorCode.INVALID_FULL_NAME,
    };
  }

  // Trim and collapse whitespace
  const normalized = raw.trim().replace(/\s+/g, ' ');

  if (normalized.length < 3 || normalized.length > MAX_FULL_NAME_LENGTH) {
    return {
      valid: false,
      normalized,
      error: ErrorCode.INVALID_FULL_NAME,
    };
  }

  const words = normalized.split(' ');
  if (words.length < 2) {
    return {
      valid: false,
      normalized,
      error: ErrorCode.INVALID_FULL_NAME,
    };
  }

  for (const word of words) {
    if (!ARABIC_OR_LATIN_WORD_REGEX.test(word)) {
      return {
        valid: false,
        normalized,
        error: ErrorCode.INVALID_FULL_NAME,
      };
    }
  }

  return {
    valid: true,
    normalized,
  };
}

