import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@app/contracts';

import {
  decodeTicketCursor,
  encodeTicketCursor,
  type TicketPageCursor,
} from './ticket-page-cursor.js';

describe('ticket page cursor', () => {
  it('round-trips the page boundary and the moment the list was cut', () => {
    const cursor: TicketPageCursor = {
      asOf: new Date('2099-01-10T08:00:00.000Z'),
      bucket: 1,
      sortKey: '-4071203400.000000',
      ticketId: '22222222-2222-4222-8222-222222222222',
    };

    expect(decodeTicketCursor(encodeTicketCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'not-base64-json',
    Buffer.from('{"a":"x","b":0,"k":"1","i":"y"}').toString('base64url'),
    Buffer.from(
      '{"a":"2099-01-10T08:00:00Z","b":2,"k":"1","i":"22222222-2222-4222-8222-222222222222"}',
    ).toString('base64url'),
    Buffer.from(
      `{"a":"2099-01-10T08:00:00Z","b":0,"k":"1; DROP TABLE ticket","i":"22222222-2222-4222-8222-222222222222"}`,
    ).toString('base64url'),
  ])('refuses a cursor it did not write (%#)', (raw) => {
    expect(() => decodeTicketCursor(raw)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    );
  });
});
