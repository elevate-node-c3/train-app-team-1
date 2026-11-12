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

  // Anything beyond the code and the fields is ignored rather than decoded:
  // the envelope has nowhere to put it, so decoding it would be dead weight.
  it('ignores keys the envelope cannot carry', () => {
    const refusal = decodeCatalogRefusal(
      refusalDetails({ dateStrip: [{ date: '2026-06-15' }] }),
    );

    expect(refusal).not.toBeNull();
    expect(Object.keys(refusal!).sort()).toEqual(['code', 'details']);
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

  /**
   * TA-20 CARRY: `toRpcException` attaches `retryAfterSeconds` to the JSON
   * only for `DEPENDENCY_UNAVAILABLE`. The gateway must read it through, not
   * drop it the way it used to drop everything beyond `code`/`details`.
   */
  it('restores retryAfterSeconds when the refusal carries one', () => {
    const refusal = decodeCatalogRefusal(
      refusalDetails({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        retryAfterSeconds: 5,
      }),
    );

    expect(refusal?.retryAfterSeconds).toBe(5);
  });

  it('leaves retryAfterSeconds undefined when the refusal carries none', () => {
    const refusal = decodeCatalogRefusal(refusalDetails());

    expect(refusal?.retryAfterSeconds).toBeUndefined();
  });
});

describe('turning a refusal into an HTTP error', () => {
  it('uses the status the code maps to', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });

    expect(exception?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  /**
   * Under `message`, not a key of our own: that is the channel
   * `HttpExceptionFilter.extractValidationDetails` reads, and it already
   * understands objects carrying field, issue and action. A parallel `details`
   * key looked right and was silently dropped, so a traveller got a 400
   * naming nothing.
   */
  it('puts the fields where the envelope filter will find them', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });

    const body = exception?.getResponse() as {
      code: string;
      message: { field: string; issue: string; action: string }[];
    };
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.message[0].field).toBe('to');
    expect(body.message[0].action).not.toBe('');
  });

  /** The CARRY this gateway task closes: Task 10's §5 handoff. */
  it('carries retryAfterSeconds onto the HttpException response', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        retryAfterSeconds: 5,
      }),
    });

    const body = exception?.getResponse() as { retryAfterSeconds?: number };
    expect(exception?.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.retryAfterSeconds).toBe(5);
  });

  it('omits retryAfterSeconds when the refusal carries none', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });

    const body = exception?.getResponse() as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBeUndefined();
  });

  // Null means "this was not a business refusal", which is what tells the
  // caller to fall back to the transport status.
  it('returns null for a transport failure', () => {
    expect(parseCatalogBusinessError({ code: 14 })).toBeNull();
    expect(parseCatalogBusinessError(new Error('boom'))).toBeNull();
    expect(parseCatalogBusinessError(undefined)).toBeNull();
  });

  /**
   * `HttpExceptionFilter` only reads `message` for validation details on a
   * 400, so a refusal whose code mapped elsewhere would arrive naming no
   * field at all -- BR-57's failure, relocated.
   *
   * Catalog only ever refuses with VALIDATION_ERROR today, and this pins that
   * so the day someone adds a second refusal code, this fails and points at
   * the reason rather than the fields quietly vanishing.
   */
  it('only carries fields on codes the envelope surfaces them for', () => {
    const exception = parseCatalogBusinessError({
      details: refusalDetails(),
    });
    const body = exception?.getResponse() as { message?: unknown };

    if (Array.isArray(body.message) && body.message.length > 0) {
      expect(
        exception?.getStatus(),
        'details only reach error.details on a 400; this refusal would lose them',
      ).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});
