import { ErrorCode } from '@app/contracts';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  decodeCatalogRefusal,
  parseCatalogBusinessError,
} from './catalog-error.js';

const refusalDetails = (
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    code: ErrorCode.VALIDATION_ERROR,
    details: [
      {
        field: 'to',
        rejectedValue: 'x',
        issue: 'is the same station as From',
        action: 'Pick a different destination station',
      },
    ],
    ...overrides,
  });

describe('decoding a catalog refusal', () => {
  it('restores the code and the field details', () => {
    const refusal = decodeCatalogRefusal(refusalDetails());

    expect(refusal?.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(refusal?.details).toHaveLength(1);
    expect(refusal?.details[0].field).toBe('to');
    expect(refusal?.details[0].action).not.toBe('');
  });

  it('restores the strip and window when they travelled', () => {
    const refusal = decodeCatalogRefusal(
      refusalDetails({
        dateStrip: [
          { date: '2026-06-15', selected: true, isToday: true, bookable: true },
        ],
        bookingWindow: {
          firstBookableDate: '2026-06-15',
          lastBookableDate: '2026-07-14',
          totalDays: 30,
        },
      }),
    );

    expect(refusal?.dateStrip).toHaveLength(1);
    expect(refusal?.bookingWindow?.lastBookableDate).toBe('2026-07-14');
  });

  /**
   * The trust rule, kept exactly as identity's client has it: a code is
   * accepted only when it names a known ErrorCode. A downstream service -- or
   * anything able to set that string -- must not be able to put an arbitrary
   * code in front of a traveller.
   */
  it('rejects a code that is not in the enum', () => {
    expect(
      decodeCatalogRefusal(JSON.stringify({ code: 'MADE_UP_CODE' })),
    ).toBeNull();
  });

  it('rejects details that are not a refusal at all', () => {
    for (const notARefusal of [
      undefined,
      null,
      '',
      'plain text',
      '{"nope":1}',
      JSON.stringify({ code: 42 }),
      JSON.stringify(['array']),
    ]) {
      expect(
        decodeCatalogRefusal(notARefusal),
        `${String(notARefusal)} should not decode`,
      ).toBeNull();
    }
  });

  // Shapes are checked, not just the code: an entry that is not a validation
  // detail is dropped rather than forwarded into the envelope.
  it('drops entries that are not validation details', () => {
    const refusal = decodeCatalogRefusal(
      refusalDetails({
        details: [
          { field: 'to', issue: 'bad', action: 'fix it' },
          'not an object',
          { field: 'from' },
          null,
        ],
      }),
    );

    expect(refusal?.details).toHaveLength(1);
    expect(refusal?.details[0].field).toBe('to');
  });

  it('tolerates a refusal with no details array', () => {
    const refusal = decodeCatalogRefusal(
      JSON.stringify({ code: ErrorCode.VALIDATION_ERROR }),
    );

    expect(refusal?.details).toEqual([]);
  });
});

describe('turning a refusal into an HTTP error', () => {
  it('uses the status the code maps to', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });

    expect(exception?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('puts the code and the fields in the response body', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });

    const body = exception?.getResponse() as {
      code: string;
      details: { field: string }[];
    };
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.details[0].field).toBe('to');
  });

  // Null means "this was not a business refusal", which is what tells the
  // caller to fall back to the transport status.
  it('returns null for a transport failure', () => {
    expect(parseCatalogBusinessError({ code: 14 })).toBeNull();
    expect(parseCatalogBusinessError(new Error('boom'))).toBeNull();
    expect(parseCatalogBusinessError(undefined)).toBeNull();
  });
});
