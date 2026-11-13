import { createValidationPipe } from '@app/common';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  CreateStationDto,
  StationIdParamDto,
  UpdateStationDto,
} from './station-requests.dto.js';

const ID = '11111111-1111-4111-8111-111111111111';
const CREATE = { cityId: ID, nameAr: 'Ramses AR', nameEn: 'Ramses' };

function body(
  value: Record<string, unknown>,
  metatype: typeof CreateStationDto | typeof UpdateStationDto,
) {
  return createValidationPipe().transform(value, { type: 'body', metatype });
}

function refusal(field: string, rejectedValue: unknown, issueKey?: string) {
  return {
    status: HttpStatus.BAD_REQUEST,
    response: {
      message: expect.arrayContaining([
        expect.objectContaining({
          field,
          rejectedValue,
          ...(issueKey ? { issueKey } : {}),
        }),
      ]),
    },
  };
}

describe('station path IDs through the native validation pipe', () => {
  it('accepts a UUID without changing it', async () => {
    const dto = await createValidationPipe().transform(
      { id: ID },
      { type: 'param', metatype: StationIdParamDto },
    );
    expect(dto).toBeInstanceOf(StationIdParamDto);
    expect(dto).toStrictEqual(
      Object.assign(new StationIdParamDto(), { id: ID }),
    );
  });

  it.each([undefined, null, '', 'ramses', ' ' + ID, ID.replaceAll('-', '')])(
    'refuses a malformed id with the shared UUID ref: %j',
    async (id) => {
      await expect(
        createValidationPipe().transform(
          { id },
          { type: 'param', metatype: StationIdParamDto },
        ),
      ).rejects.toMatchObject(refusal('id', id, 'ISSUE_MUST_BE_UUID'));
    },
  );
});

describe('station creates through the native validation pipe', () => {
  it('trims both names and aliases without changing the input or defaulting activity', async () => {
    const aliases = Object.freeze(['  Ramsis ', ' Cairo  ']);
    const input = Object.freeze({
      cityId: ID,
      nameAr: '  Ramses AR  ',
      nameEn: '  Ramses  ',
      altSpellings: aliases,
    });

    const dto = await body(input, CreateStationDto);

    expect(dto).toBeInstanceOf(CreateStationDto);
    expect(dto).toMatchObject({
      cityId: ID,
      nameAr: 'Ramses AR',
      nameEn: 'Ramses',
      altSpellings: ['Ramsis', 'Cairo'],
    });
    expect(dto).not.toHaveProperty('isActive');
    expect(input.nameEn).toBe('  Ramses  ');
    expect(input.altSpellings).toEqual(['  Ramsis ', ' Cairo  ']);
  });

  it.each(['nameAr', 'nameEn'] as const)(
    'requires a nonblank %s of at most 120 characters',
    async (field) => {
      for (const value of [
        undefined,
        null,
        '',
        ' \t ',
        42,
        [],
        {},
        'x'.repeat(121),
      ]) {
        const rejectedValue = typeof value === 'string' ? value.trim() : value;
        await expect(
          body({ ...CREATE, [field]: value }, CreateStationDto),
        ).rejects.toMatchObject(refusal(field, rejectedValue));
      }
      const dto = await body(
        { ...CREATE, [field]: ' ' + 'x'.repeat(120) + ' ' },
        CreateStationDto,
      );
      expect(dto[field]).toBe('x'.repeat(120));
    },
  );

  it.each([true, false])(
    'keeps optional isActive=%s as a boolean',
    async (isActive) => {
      expect(
        await body({ ...CREATE, isActive }, CreateStationDto),
      ).toHaveProperty('isActive', isActive);
    },
  );

  it('leaves omitted optional create fields absent', async () => {
    const dto = await body(CREATE, CreateStationDto);
    expect(Object.keys(dto).sort()).toEqual(['cityId', 'nameAr', 'nameEn']);
  });
});

describe('station PATCH bodies through the native validation pipe', () => {
  it('allows an empty patch without inventing fields so catalog can refuse it', async () => {
    const dto = await body({}, UpdateStationDto);
    expect(dto).toBeInstanceOf(UpdateStationDto);
    expect(Object.keys(dto)).toEqual([]);
  });

  it('allows explicit undefined without replacing any value', async () => {
    const input = {
      cityId: undefined,
      nameAr: undefined,
      nameEn: undefined,
      altSpellings: undefined,
      isActive: undefined,
    };
    const dto = await body(input, UpdateStationDto);
    expect(dto).toMatchObject(input);
    expect(Object.values(dto).every((value) => value === undefined)).toBe(true);
  });

  it.each(['cityId', 'nameAr', 'nameEn', 'altSpellings', 'isActive'])(
    'refuses null instead of treating %s as absent',
    async (field) => {
      await expect(
        body({ [field]: null }, UpdateStationDto),
      ).rejects.toMatchObject(refusal(field, null));
    },
  );

  it.each(['nameAr', 'nameEn'] as const)(
    'validates and trims a supplied %s without requiring the other name',
    async (field) => {
      const dto = await body({ [field]: '  New name  ' }, UpdateStationDto);
      expect(dto[field]).toBe('New name');
      expect(Object.keys(dto)).toEqual([field]);
      for (const value of ['', ' \t ', 42, [], {}, 'x'.repeat(121)]) {
        await expect(
          body({ [field]: value }, UpdateStationDto),
        ).rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
        });
      }
      expect(
        await body({ [field]: 'x'.repeat(120) }, UpdateStationDto),
      ).toHaveProperty(field, 'x'.repeat(120));
    },
  );

  it('retains false and an explicit empty aliases array while trimming only supplied names', async () => {
    const dto = await body(
      { nameEn: '  Ramses  ', isActive: false, altSpellings: [] },
      UpdateStationDto,
    );
    expect(dto).toMatchObject({
      nameEn: 'Ramses',
      isActive: false,
      altSpellings: [],
    });
    expect(dto).not.toHaveProperty('nameAr');
    expect(dto).not.toHaveProperty('cityId');
    expect(dto).not.toHaveProperty('aliases');
  });
});

describe.each([
  { name: 'create', metatype: CreateStationDto, base: CREATE },
  { name: 'patch', metatype: UpdateStationDto, base: {} },
])('shared $name station shape validation', ({ metatype, base }) => {
  it.each([undefined, null, '', 'cairo', ' ' + ID, ID.replaceAll('-', '')])(
    'validates a supplied cityId as a UUID: %j',
    async (cityId) => {
      if (cityId === undefined && metatype === UpdateStationDto) {
        await expect(
          body({ ...base, cityId }, metatype),
        ).resolves.toHaveProperty('cityId', undefined);
      } else {
        await expect(body({ ...base, cityId }, metatype)).rejects.toMatchObject(
          refusal('cityId', cityId, 'ISSUE_MUST_BE_UUID'),
        );
      }
    },
  );

  it.each(['true', 'false', '', 0, 1, null, [], {}])(
    'rejects non-boolean activity rather than coercing it: %j',
    async (isActive) => {
      await expect(body({ ...base, isActive }, metatype)).rejects.toMatchObject(
        refusal('isActive', isActive, 'ISSUE_MUST_BE_YES_OR_NO'),
      );
    },
  );

  it.each([undefined, [], ['  Ramsis  '], Array(100).fill('x'.repeat(120))])(
    'accepts optional bounded aliases, including an explicit clear: %j',
    async (altSpellings) => {
      const dto = await body({ ...base, altSpellings }, metatype);
      expect(dto.altSpellings).toEqual(
        altSpellings?.map((alias) => alias.trim()),
      );
    },
  );

  it.each([null, '', 'Ramsis', 42, {}, true])(
    'requires aliases to be an array: %j',
    async (altSpellings) => {
      await expect(
        body({ ...base, altSpellings }, metatype),
      ).rejects.toMatchObject(
        refusal('altSpellings', altSpellings, 'ISSUE_MUST_BE_LIST'),
      );
    },
  );

  it.each(['', ' \t ', null, undefined, 42, {}, 'x'.repeat(121)])(
    'rejects a blank, non-string or oversized alias element: %j',
    async (alias) => {
      await expect(
        body({ ...base, altSpellings: ['valid', alias] }, metatype),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    },
  );

  it('rejects more than 100 aliases with an existing shared ref', async () => {
    const altSpellings = Array(101).fill('alias');
    await expect(
      body({ ...base, altSpellings }, metatype),
    ).rejects.toMatchObject(
      refusal('altSpellings', altSpellings, 'ISSUE_ABOVE_MAXIMUM'),
    );
  });

  it.each([
    'stationId',
    'governorateId',
    'aliases',
    'createdAt',
    'actorAccountId',
  ])('rejects an internal or immutable field: %s', async (field) => {
    await expect(
      body({ ...base, [field]: ID }, metatype),
    ).rejects.toMatchObject(refusal(field, ID, 'ISSUE_UNKNOWN_FIELD'));
  });
});
