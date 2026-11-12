import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationError,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { ValidationIssueRef } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { resolveDetailText } from './detail-catalogue.js';
import {
  createValidationPipe,
  validationExceptionFactory,
} from './validation-exception.factory.js';

class MappedConstraintsDto {
  @IsUUID()
  isUuid!: string;

  @IsInt()
  isInt!: number;

  @Min(1)
  min!: number;

  @Max(10)
  max!: number;

  @Matches(/^expected$/)
  matches!: string;

  @IsBoolean()
  isBoolean!: boolean;

  @IsIn(['accepted'])
  isIn!: string;

  @IsString()
  isString!: string;

  @IsArray()
  isArray!: unknown[];

  @IsNotEmpty()
  isNotEmpty!: string;

  @IsDefined()
  isDefined!: string;

  @IsEmail()
  isEmail!: string;

  @IsISO8601()
  isIso8601!: string;

  @MinLength(4)
  minLength!: string;

  @MaxLength(4)
  maxLength!: string;

  @ArrayMinSize(2)
  arrayMinSize!: unknown[];
}

const validMappedInput = {
  isUuid: '11111111-1111-4111-8111-111111111111',
  isInt: 1,
  min: 1,
  max: 10,
  matches: 'expected',
  isBoolean: true,
  isIn: 'accepted',
  isString: 'text',
  isArray: [],
  isNotEmpty: 'provided',
  isDefined: 'provided',
  isEmail: 'traveller@example.com',
  isIso8601: '2026-12-01T06:00:00Z',
  minLength: 'text',
  maxLength: 'text',
  arrayMinSize: [1, 2],
};

class ContextDateDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    context: {
      issueKey: 'ISSUE_CIVIL_DATE_FORMAT',
      actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
      params: { departureDate: '2026-12-01' },
    },
  })
  date!: string;
}

class MultipleConstraintsDto {
  @IsInt()
  @Min(1)
  count!: number;
}

class MultipleContextsDto {
  @IsInt({ context: { issueKey: 'ISSUE_TRAIN_NUMBER_NOT_A_NUMBER' } })
  @Min(1, { context: { issueKey: 'ISSUE_TRAIN_NUMBER_TOO_SMALL' } })
  count!: number;
}

@ValidatorConstraint({ name: 'unmappedConstraint', async: false })
class UnmappedConstraint implements ValidatorConstraintInterface {
  validate(): boolean {
    return false;
  }

  defaultMessage(): string {
    return 'Internal validator prose must not escape.';
  }
}

class CustomConstraintDto {
  @Validate(UnmappedConstraint)
  value!: string;
}

@ValidatorConstraint({ name: 'toString', async: false })
class PrototypeNamedConstraint implements ValidatorConstraintInterface {
  validate(): boolean {
    return false;
  }
}

class PrototypeNamedConstraintDto {
  @Validate(PrototypeNamedConstraint)
  value!: string;
}

class StopDto {
  @IsUUID()
  stationId!: string;
}

class RouteDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops!: StopDto[];
}

async function validationDetails(
  metatype: new () => object,
  input: Record<string, unknown>,
): Promise<ValidationIssueRef[]> {
  const exception: unknown = await createValidationPipe()
    .transform(input, { type: 'body', metatype })
    .catch((error: unknown) => error);

  expect(exception).toBeInstanceOf(BadRequestException);
  const response = (exception as BadRequestException).getResponse() as {
    message: ValidationIssueRef[];
  };
  return response.message;
}

describe('validationExceptionFactory through the real validation pipe', () => {
  it.each([
    { field: 'isUuid', value: 'nope', issueKey: 'ISSUE_MUST_BE_UUID' },
    { field: 'isInt', value: 0.5, issueKey: 'ISSUE_MUST_BE_WHOLE_NUMBER' },
    { field: 'min', value: 0, issueKey: 'ISSUE_BELOW_MINIMUM' },
    { field: 'max', value: 11, issueKey: 'ISSUE_ABOVE_MAXIMUM' },
    { field: 'matches', value: 'other', issueKey: 'ISSUE_WRONG_FORMAT' },
    { field: 'isBoolean', value: 'true', issueKey: 'ISSUE_MUST_BE_YES_OR_NO' },
    { field: 'isIn', value: 'other', issueKey: 'ISSUE_NOT_AN_ALLOWED_VALUE' },
    { field: 'isString', value: 1, issueKey: 'ISSUE_MUST_BE_TEXT' },
    { field: 'isArray', value: 'list', issueKey: 'ISSUE_MUST_BE_LIST' },
    { field: 'isNotEmpty', value: '', issueKey: 'ISSUE_REQUIRED' },
    { field: 'isDefined', value: undefined, issueKey: 'ISSUE_REQUIRED' },
    {
      field: 'isEmail',
      value: 'not-an-email',
      issueKey: 'ISSUE_MUST_BE_EMAIL',
    },
    {
      field: 'isIso8601',
      value: 'tomorrow',
      issueKey: 'ISSUE_ISO_DATE_TIME_FORMAT',
    },
    { field: 'minLength', value: 'abc', issueKey: 'ISSUE_TEXT_TOO_SHORT' },
    { field: 'maxLength', value: 'abcde', issueKey: 'ISSUE_TEXT_TOO_LONG' },
    { field: 'arrayMinSize', value: [1], issueKey: 'ISSUE_LIST_TOO_SHORT' },
  ])(
    'maps the actual $field constraint to $issueKey',
    async ({ field, value, issueKey }) => {
      const details = await validationDetails(MappedConstraintsDto, {
        ...validMappedInput,
        [field]: value,
      });

      // Exact shape also pins the absence of prose, inferred params, and a default action key.
      expect(details).toEqual([{ field, rejectedValue: value, issueKey }]);
    },
  );

  it('prefers context keys and carries only explicitly supplied action and params', async () => {
    const details = await validationDetails(ContextDateDto, {
      date: 'not-a-date',
    });

    expect(details).toEqual([
      {
        field: 'date',
        rejectedValue: 'not-a-date',
        issueKey: 'ISSUE_CIVIL_DATE_FORMAT',
        actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        params: { departureDate: '2026-12-01' },
      },
    ]);
  });

  it('emits one ref per failed constraint on the same field', async () => {
    const details = await validationDetails(MultipleConstraintsDto, {
      count: 0.5,
    });

    expect(details).toHaveLength(2);
    expect(details).toEqual(
      expect.arrayContaining([
        {
          field: 'count',
          rejectedValue: 0.5,
          issueKey: 'ISSUE_MUST_BE_WHOLE_NUMBER',
        },
        { field: 'count', rejectedValue: 0.5, issueKey: 'ISSUE_BELOW_MINIMUM' },
      ]),
    );
  });

  it('reads overrides from the matching constraint rather than another failure on the field', async () => {
    const details = await validationDetails(MultipleContextsDto, {
      count: 0.5,
    });

    expect(details).toHaveLength(2);
    expect(details).toEqual(
      expect.arrayContaining([
        {
          field: 'count',
          rejectedValue: 0.5,
          issueKey: 'ISSUE_TRAIN_NUMBER_NOT_A_NUMBER',
        },
        {
          field: 'count',
          rejectedValue: 0.5,
          issueKey: 'ISSUE_TRAIN_NUMBER_TOO_SMALL',
        },
      ]),
    );
  });

  it('falls back for an unknown custom constraint without carrying its default prose', async () => {
    const details = await validationDetails(CustomConstraintDto, {
      value: 'rejected',
    });

    expect(details).toEqual([
      {
        field: 'value',
        rejectedValue: 'rejected',
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
    expect(JSON.stringify(details)).not.toContain('Internal validator prose');
    expect(resolveDetailText(details[0].issueKey, 'en')).toBe(
      'This value is not valid.',
    );
    expect(resolveDetailText(details[0].issueKey, 'ar')).toBe(
      'هذه القيمة غير صالحة.',
    );
  });

  it('does not treat inherited object properties as mapped custom constraint names', async () => {
    expect(
      await validationDetails(PrototypeNamedConstraintDto, {
        value: 'rejected',
      }),
    ).toEqual([
      {
        field: 'value',
        rejectedValue: 'rejected',
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
  });

  it('keeps nested paths and the fallback refs on parents without constraints', async () => {
    const details = await validationDetails(RouteDto, {
      stops: [{ stationId: 'nope' }],
    });

    expect(details.map(({ field, issueKey }) => ({ field, issueKey }))).toEqual(
      [
        { field: 'stops', issueKey: 'ISSUE_VALIDATION_FAILED' },
        { field: 'stops.0', issueKey: 'ISSUE_VALIDATION_FAILED' },
        { field: 'stops.0.stationId', issueKey: 'ISSUE_MUST_BE_UUID' },
      ],
    );
    expect(details[2]).toEqual({
      field: 'stops.0.stationId',
      rejectedValue: 'nope',
      issueKey: 'ISSUE_MUST_BE_UUID',
    });
    expect(details.every((detail) => !Object.hasOwn(detail, 'target'))).toBe(
      true,
    );
  });

  it('maps real whitelist violations and preserves the rejected value', async () => {
    const rejectedValue = { nested: ['unexpected'] };
    const details = await validationDetails(MappedConstraintsDto, {
      ...validMappedInput,
      unknownField: rejectedValue,
    });

    expect(details).toEqual([
      { field: 'unknownField', rejectedValue, issueKey: 'ISSUE_UNKNOWN_FIELD' },
    ]);
  });
});

describe('validationExceptionFactory without constraints', () => {
  it.each([undefined, {}])(
    'keeps a fallback ref for a leaf with constraints %j without exposing its target',
    (constraints) => {
      const error: ValidationError = {
        property: 'value',
        value: 42,
        constraints,
        target: { privateField: 'private target' },
        children: [],
      };

      expect(validationExceptionFactory([error]).getResponse()).toEqual({
        message: [
          {
            field: 'value',
            rejectedValue: 42,
            issueKey: 'ISSUE_VALIDATION_FAILED',
          },
        ],
      });
    },
  );
});

describe('DTO detail copy', () => {
  it.each([
    {
      key: 'ISSUE_CIVIL_DATE_FORMAT',
      en: 'This date must be written as YYYY-MM-DD.',
      ar: 'يجب كتابة هذا التاريخ على صورة YYYY-MM-DD.',
    },
    {
      key: 'ISSUE_TRAIN_NUMBER_NOT_A_NUMBER',
      en: 'A train number must be a whole number.',
      ar: 'رقم القطار يجب أن يكون عدداً صحيحاً.',
    },
    {
      key: 'ISSUE_TRAIN_NUMBER_TOO_SMALL',
      en: 'A train number starts at 1.',
      ar: 'رقم القطار يبدأ من 1.',
    },
    {
      key: 'ISSUE_SORT_NOT_OFFERED',
      en: 'This is not one of the offered sort orders.',
      ar: 'هذا ليس من ترتيبات الفرز المتاحة.',
    },
    {
      key: 'ISSUE_TRAIN_TYPE_LIST_MALFORMED',
      en: 'Train types must be a comma-separated list of identifiers.',
      ar: 'أنواع القطارات يجب أن تكون قائمة معرفات مفصولة بفواصل.',
    },
    {
      key: 'ISSUE_CLOCK_TIME_FORMAT',
      en: 'This time must be written as HH:mm.',
      ar: 'يجب كتابة هذا الوقت على صورة HH:mm.',
    },
    {
      key: 'ISSUE_FARE_NOT_A_NUMBER',
      en: 'A fare must be a whole number of piastres.',
      ar: 'الأجرة يجب أن تكون عدداً صحيحاً من القروش.',
    },
    {
      key: 'ISSUE_FARE_NEGATIVE',
      en: 'A fare cannot be negative.',
      ar: 'الأجرة لا يمكن أن تكون سالبة.',
    },
    {
      key: 'ISSUE_VERIFICATION_CODE_FORMAT',
      en: 'This verification code must contain exactly six digits.',
      ar: 'رمز التحقق يجب أن يتكوّن من ستة أرقام فقط.',
    },
    {
      key: 'ISSUE_SAME_STATION_AS_ORIGIN',
      en: 'The destination is the same as the origin.',
      ar: 'محطة الوصول هي نفس محطة المغادرة.',
    },
    {
      key: 'ACTION_PICK_DIFFERENT_DESTINATION',
      en: 'Pick a different destination station.',
      ar: 'اختر محطة وصول مختلفة.',
    },
    {
      key: 'ISSUE_ISO_DATE_TIME_FORMAT',
      en: 'This value must be a valid date or time in ISO-8601 format.',
      ar: 'يجب أن تكون هذه القيمة تاريخاً أو وقتاً صالحاً على صورة ISO-8601.',
    },
    {
      key: 'ISSUE_TEXT_TOO_SHORT',
      en: 'This text is shorter than the minimum allowed length.',
      ar: 'هذا النص أقصر من الحد الأدنى للطول المسموح به.',
    },
    {
      key: 'ISSUE_TEXT_TOO_LONG',
      en: 'This text is longer than the maximum allowed length.',
      ar: 'هذا النص أطول من الحد الأقصى للطول المسموح به.',
    },
    {
      key: 'ISSUE_LIST_TOO_SHORT',
      en: 'This list contains fewer items than the minimum allowed.',
      ar: 'تحتوي هذه القائمة على عناصر أقل من الحد الأدنى المسموح به.',
    },
  ])('resolves $key to its complete bilingual sentences', ({ key, en, ar }) => {
    expect(resolveDetailText(key, 'en')).toBe(en);
    expect(resolveDetailText(key, 'ar')).toBe(ar);
    expect(`${en} ${ar}`).not.toMatch(/please|يرجى|عفوا|stripe/i);
  });
});
