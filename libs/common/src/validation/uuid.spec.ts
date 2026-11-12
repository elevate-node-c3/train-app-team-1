import { describe, expect, it } from 'vitest';

import {
  RFC_UUID_PATTERN,
  UUID_SHAPE_PATTERN,
  isRfcUuid,
  isUuidShape,
  uuidShapedOnly,
} from './uuid.js';

const VALID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NIL = '00000000-0000-0000-0000-000000000000';

describe('UUID patterns', () => {
  it('keeps database-safe hex shape distinct from RFC validity', () => {
    expect(UUID_SHAPE_PATTERN.test(NIL)).toBe(true);
    expect(RFC_UUID_PATTERN.test(NIL)).toBe(false);
  });
});

describe('isUuidShape', () => {
  it('accepts a v4 uuid', () => {
    expect(isUuidShape(VALID)).toBe(true);
  });

  it('accepts the nil uuid, which a uuid column also accepts', () => {
    expect(isUuidShape(NIL)).toBe(true);
  });

  it('does not constrain the version or variant nibbles', () => {
    expect(isUuidShape('3f2504e0-4f89-91d3-ca0c-0305e82c3301')).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isUuidShape(VALID.toUpperCase())).toBe(true);
  });

  it('rejects malformed strings and non-strings', () => {
    for (const value of [
      'not-a-uuid',
      VALID.replaceAll('-', ''),
      `g${VALID.slice(1)}`,
      42,
      null,
      undefined,
      {},
      [VALID],
    ]) {
      expect(isUuidShape(value)).toBe(false);
    }
  });
});

describe('isRfcUuid', () => {
  it('accepts a v4 uuid', () => {
    expect(isRfcUuid(VALID)).toBe(true);
  });

  it('rejects the nil uuid that isUuidShape accepts', () => {
    expect(isUuidShape(NIL)).toBe(true);
    expect(isRfcUuid(NIL)).toBe(false);
  });

  it('accepts versions 1 through 8 and rejects other version nibbles', () => {
    for (const version of '12345678') {
      expect(isRfcUuid(`3f2504e0-4f89-${version}1d3-9a0c-0305e82c3301`)).toBe(
        true,
      );
    }
    for (const version of '09abcdef') {
      expect(isRfcUuid(`3f2504e0-4f89-${version}1d3-9a0c-0305e82c3301`)).toBe(
        false,
      );
    }
  });

  it('accepts only the RFC variant nibbles', () => {
    for (const variant of '89ab') {
      expect(isRfcUuid(`3f2504e0-4f89-41d3-${variant}a0c-0305e82c3301`)).toBe(
        true,
      );
    }
    for (const variant of '01234567cdef') {
      expect(isRfcUuid(`3f2504e0-4f89-41d3-${variant}a0c-0305e82c3301`)).toBe(
        false,
      );
    }
  });

  it('accepts uppercase hex', () => {
    expect(isRfcUuid(VALID.toUpperCase())).toBe(true);
  });

  it('rejects malformed strings and non-strings', () => {
    for (const value of ['not-a-uuid', 42, null, undefined, {}, [VALID]]) {
      expect(isRfcUuid(value)).toBe(false);
    }
  });
});

describe('uuidShapedOnly', () => {
  it('drops malformed ids and deduplicates the rest', () => {
    expect(uuidShapedOnly([VALID, 'oops', VALID])).toEqual([VALID]);
  });

  it('keeps nil and hex-shaped ids with non-RFC version and variant nibbles', () => {
    const hexShaped = '3f2504e0-4f89-91d3-ca0c-0305e82c3301';
    expect(uuidShapedOnly([NIL, hexShaped, NIL])).toEqual([NIL, hexShaped]);
  });

  it('preserves order, casing, and the input array', () => {
    const upper = VALID.toUpperCase();
    const ids = [upper, 'oops', VALID, upper, NIL];

    expect(uuidShapedOnly(ids)).toEqual([upper, VALID, NIL]);
    expect(ids).toEqual([upper, 'oops', VALID, upper, NIL]);
  });

  it('returns an empty list when no ids have UUID shape', () => {
    expect(uuidShapedOnly([])).toEqual([]);
    expect(uuidShapedOnly(['oops', ''])).toEqual([]);
  });
});
