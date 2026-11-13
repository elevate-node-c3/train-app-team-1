import { ErrorCode, type ValidationIssueRef } from '@app/contracts';
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
  details: ValidationIssueRef[];
  normalizedFullName: string;
  canonicalPhone: string;
  normalizedNationalId: string;
}

export function nationalIdErrorToDetail(
  code: ErrorCode,
  rejectedValue: unknown,
): ValidationIssueRef {
  switch (code) {
    case ErrorCode.INVALID_NATIONAL_ID_LENGTH:
      return {
        field: 'nationalId',
        rejectedValue,
        issueKey: 'ISSUE_NATIONAL_ID_LENGTH',
        actionKey: 'ACTION_SEND_14_DIGIT_NATIONAL_ID',
      };
    case ErrorCode.INVALID_NATIONAL_ID_CENTURY:
      return {
        field: 'nationalId',
        rejectedValue,
        issueKey: 'ISSUE_NATIONAL_ID_CENTURY_DIGIT',
        actionKey: 'ACTION_CHECK_NATIONAL_ID_CENTURY_DIGIT',
      };
    case ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE:
      return {
        field: 'nationalId',
        rejectedValue,
        issueKey: 'ISSUE_NATIONAL_ID_BIRTH_DATE',
        actionKey: 'ACTION_CHECK_NATIONAL_ID_BIRTH_DATE',
      };
    case ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE:
      return {
        field: 'nationalId',
        rejectedValue,
        issueKey: 'ISSUE_NATIONAL_ID_GOVERNORATE',
        actionKey: 'ACTION_CHECK_NATIONAL_ID_GOVERNORATE',
      };
    default:
      return {
        field: 'nationalId',
        rejectedValue,
        issueKey: 'ISSUE_NATIONAL_ID_INVALID',
        actionKey: 'ACTION_SEND_14_DIGIT_NATIONAL_ID',
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
  const details: ValidationIssueRef[] = [];

  const nameResult = validateFullName(input.fullName);
  if (!nameResult.valid) {
    details.push({
      field: 'fullName',
      rejectedValue: input.fullName,
      issueKey: 'ISSUE_FULL_NAME_INVALID',
      actionKey: 'ACTION_SEND_FIRST_AND_FAMILY_NAME',
    });
  }

  const phoneResult = normalizePhone(input.phoneNumber);
  if (!phoneResult.valid) {
    details.push({
      field: 'phoneNumber',
      rejectedValue: input.phoneNumber,
      issueKey: 'ISSUE_PHONE_NOT_EGYPTIAN_MOBILE',
      actionKey: 'ACTION_SEND_EGYPTIAN_MOBILE',
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
      issueKey: 'ISSUE_PROFILE_TYPE_NOT_ACCEPTED',
      actionKey: 'ACTION_PICK_PROFILE_TYPE_FROM_OPTIONS',
    });
  }

  if (!references.nationalityExists) {
    details.push({
      field: 'nationality',
      rejectedValue: input.nationality,
      issueKey: 'ISSUE_NATIONALITY_NOT_ACCEPTED',
      actionKey: 'ACTION_PICK_NATIONALITY_FROM_OPTIONS',
    });
  }

  return {
    details,
    normalizedFullName: nameResult.normalized,
    canonicalPhone: phoneResult.normalized,
    normalizedNationalId: nidResult.normalized,
  };
}
