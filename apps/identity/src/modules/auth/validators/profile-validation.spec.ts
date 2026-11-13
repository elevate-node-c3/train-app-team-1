import { describe, expect, it } from 'vitest';
import { DETAIL_CATALOGUE } from '@app/common/envelope/detail-catalogue.js';
import { validateProfile } from './profile-validation.js';

describe('validateProfile', () => {
  const NOW = new Date('2026-10-24T10:00:00.000Z');
  const validReferences = {
    profileTypeExists: true,
    nationalityExists: true,
  };

  const validInput = {
    fullName: 'Ahmed Hussein',
    phoneNumber: '01001234567',
    nationalId: '28505150101235', // 1985-05-15, Cairo (01)
    profileType: 'Regular',
    nationality: 'Egyptian',
  };

  it('accepts completely valid profile input with zero details', () => {
    const result = validateProfile(validInput, NOW, validReferences);
    expect(result.details).toEqual([]);
    expect(result.normalizedFullName).toBe('Ahmed Hussein');
    expect(result.canonicalPhone).toBe('01001234567');
    expect(result.normalizedNationalId).toBe('28505150101235');
  });

  it('collects multiple field failures in a single pass', () => {
    const badInput = {
      fullName: 'Single',
      phoneNumber: 'not-a-phone',
      nationalId: '26582264865', // 11 digits
      profileType: 'UnknownType',
      nationality: 'UnknownNationality',
    };

    const result = validateProfile(badInput, NOW, {
      profileTypeExists: false,
      nationalityExists: false,
    });

    const fields = result.details.map((d) => d.field);
    expect(fields).toContain('fullName');
    expect(fields).toContain('phoneNumber');
    expect(fields).toContain('nationalId');
    expect(fields).toContain('profileType');
    expect(fields).toContain('nationality');

    // Every detail must name a field and the keys the gateway resolves (BR-57)
    for (const detail of result.details) {
      expect(detail.field.length).toBeGreaterThan(0);
      expect(DETAIL_CATALOGUE).toHaveProperty(detail.issueKey);
      expect(DETAIL_CATALOGUE).toHaveProperty(String(detail.actionKey));
    }
  });

  it('collects all National ID structural errors together if NID has multiple failures', () => {
    // 14 digits: century 2, birth date 99-02-31 (invalid), governorate 99 (invalid)
    const result = validateProfile(
      {
        ...validInput,
        nationalId: '29902319901234',
      },
      NOW,
      validReferences,
    );

    const nidDetails = result.details.filter((d) => d.field === 'nationalId');
    expect(nidDetails.length).toBe(2);
    expect(nidDetails.map((d) => d.issueKey)).toEqual([
      'ISSUE_NATIONAL_ID_BIRTH_DATE',
      'ISSUE_NATIONAL_ID_GOVERNORATE',
    ]);
  });
});
