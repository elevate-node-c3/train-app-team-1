import { ErrorCode, type ValidationErrorDetail } from '@app/contracts';
import { validateFullName } from './full-name.validator.js';
import { normalizePhone } from './phone.validator.js';
import { validateNationalId } from './national-id.validator.js';

export interface ProfileValidationInput {
  fullName: string;
  phoneNumber: string;
  nationalId: string;
  profileType: string;
  nationality: string;
}

export interface ProfileValidationReferences {
  profileTypeExists: boolean;
  nationalityExists: boolean;
}

export interface ProfileValidationResult {
  details: ValidationErrorDetail[];
  normalizedFullName: string;
  canonicalPhone: string;
  normalizedNationalId: string;
}

export function nationalIdErrorToDetail(
  code: ErrorCode,
  rejectedValue: unknown,
): ValidationErrorDetail {
  switch (code) {
    case ErrorCode.INVALID_NATIONAL_ID_LENGTH:
      return {
        field: 'nationalId',
        rejectedValue,
        issue: 'must be exactly 14 digits',
        action: 'Enter a 14-digit Egyptian National ID',
      };
    case ErrorCode.INVALID_NATIONAL_ID_CENTURY:
      return {
        field: 'nationalId',
        rejectedValue,
        issue: 'century digit must be 2 (1900s) or 3 (2000s)',
        action: 'Check the first digit of the National ID',
      };
    case ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE:
      return {
        field: 'nationalId',
        rejectedValue,
        issue: 'birth date in National ID is not a valid date or is in the future',
        action: 'Check digits 2 through 7 (YYMMDD) in the National ID',
      };
    case ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE:
      return {
        field: 'nationalId',
        rejectedValue,
        issue: 'governorate code in National ID is not recognized',
        action: 'Check digits 8 and 9 (governorate code) in the National ID',
      };
    default:
      return {
        field: 'nationalId',
        rejectedValue,
        issue: 'National ID is invalid',
        action: 'Enter a valid 14-digit Egyptian National ID',
      };
  }
}

/**
 * Validates all complete profile inputs in one pass (BR-10, BR-11, BR-13, BR-57).
 * Collects all field-level failures so the client receives all issues in a single refusal.
 */
export function validateProfile(
  input: ProfileValidationInput,
  now: Date,
  references: ProfileValidationReferences,
): ProfileValidationResult {
  const details: ValidationErrorDetail[] = [];

  const nameResult = validateFullName(input.fullName);
  if (!nameResult.valid) {
    details.push({
      field: 'fullName',
      rejectedValue: input.fullName,
      issue: 'is not a valid full name (at least first and family name with Arabic or Latin letters, up to 50 characters)',
      action: 'Enter a valid full name with at least first and family name',
    });
  }

  const phoneResult = normalizePhone(input.phoneNumber);
  if (!phoneResult.valid) {
    details.push({
      field: 'phoneNumber',
      rejectedValue: input.phoneNumber,
      issue: 'is not a valid Egyptian mobile number',
      action: 'Enter an 11-digit Egyptian mobile number starting with 010, 011, 012, or 015',
    });
  }

  const nidResult = validateNationalId(input.nationalId, now);
  if (!nidResult.valid) {
    for (const error of nidResult.errors) {
      details.push(nationalIdErrorToDetail(error, input.nationalId));
    }
  }

  if (!references.profileTypeExists) {
    details.push({
      field: 'profileType',
      rejectedValue: input.profileType,
      issue: 'is not an accepted profile type',
      action: 'Choose an accepted profile type from the options list',
    });
  }

  if (!references.nationalityExists) {
    details.push({
      field: 'nationality',
      rejectedValue: input.nationality,
      issue: 'is not an accepted nationality',
      action: 'Choose an accepted nationality from the options list',
    });
  }

  return {
    details,
    normalizedFullName: nameResult.normalized,
    canonicalPhone: phoneResult.normalized,
    normalizedNationalId: nidResult.normalized,
  };
}
