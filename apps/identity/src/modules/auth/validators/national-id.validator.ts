import { ErrorCode } from '@app/contracts';
import { normalizeDigits } from './arabic-digits.js';

export const EGYPTIAN_GOVERNORATE_CODES = new Set([
  '01', // Cairo
  '02', // Alexandria
  '03', // Port Said
  '04', // Suez
  '11', // Damietta
  '12', // Dakahlia
  '13', // Ash Sharqia
  '14', // Al Qalyubia
  '15', // Kafr El Sheikh
  '16', // Gharbia
  '17', // Monufia
  '18', // Beheira
  '19', // Ismailia
  '21', // Giza
  '22', // Beni Suef
  '23', // Faiyum
  '24', // Minya
  '25', // Asyut
  '26', // Sohag
  '27', // Qena
  '28', // Aswan
  '29', // Luxor
  '31', // Red Sea
  '32', // New Valley
  '33', // Matrouh
  '34', // North Sinai
  '35', // South Sinai
  '88', // Citizens born abroad
]);

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export interface NationalIdValidationResult {
  valid: boolean;
  normalized: string;
  errors: ErrorCode[];
}

/**
 * Validates Egyptian 14-digit National ID (BR-11).
 * Normalizes Arabic digits to Western digits first.
 */
export function validateNationalId(
  raw: string,
  now: Date = new Date(),
): NationalIdValidationResult {
  const normalized = normalizeDigits(raw.trim());
  const errors: ErrorCode[] = [];

  if (!/^\d{14}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      errors: [ErrorCode.INVALID_NATIONAL_ID_LENGTH],
    };
  }

  const centuryChar = normalized[0];
  let year = 0;
  if (centuryChar === '2') {
    year = 1900 + parseInt(normalized.slice(1, 3), 10);
  } else if (centuryChar === '3') {
    year = 2000 + parseInt(normalized.slice(1, 3), 10);
  } else {
    errors.push(ErrorCode.INVALID_NATIONAL_ID_CENTURY);
  }

  const month = parseInt(normalized.slice(3, 5), 10);
  const day = parseInt(normalized.slice(5, 7), 10);

  if (year > 0) {
    const maxDays = daysInMonth(year, month);
    if (month < 1 || month > 12 || day < 1 || day > maxDays) {
      errors.push(ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE);
    } else {
      const birthDate = new Date(Date.UTC(year, month - 1, day));
      if (birthDate.getTime() > now.getTime()) {
        errors.push(ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE);
      }
    }
  }

  const govCode = normalized.slice(7, 9);
  if (!EGYPTIAN_GOVERNORATE_CODES.has(govCode)) {
    errors.push(ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE);
  }

  return {
    valid: errors.length === 0,
    normalized,
    errors,
  };
}
