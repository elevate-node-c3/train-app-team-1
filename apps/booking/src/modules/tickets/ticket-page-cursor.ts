import { ErrorCode } from '@app/contracts';

import { BookingFlowError } from '../flow/booking-flow-error.js';

/**
 * Where a page of tickets ended, opaque to the client.
 *
 * BR-40 orders upcoming tickets first (nearest departure first) and past ones
 * after (most recent first). That order is one sortable tuple per ticket:
 * `bucket` (0 upcoming, 1 past), `sortKey` (the departure's epoch, negated for
 * past tickets) and the ticket id as the unique tie-breaker.
 *
 * `asOf` is fixed by the first page and carried by every later one, so a
 * ticket whose journey ends mid-scroll cannot change bucket between pages and
 * be shown twice or skipped.
 */
export interface TicketPageCursor {
  asOf: Date;
  bucket: number;
  /** Postgres numeric, kept as text so no precision is lost on the way. */
  sortKey: string;
  ticketId: string;
}

export function encodeTicketCursor(cursor: TicketPageCursor): string {
  return Buffer.from(
    JSON.stringify({
      a: cursor.asOf.toISOString(),
      b: cursor.bucket,
      k: cursor.sortKey,
      i: cursor.ticketId,
    }),
  ).toString('base64url');
}

export function decodeTicketCursor(raw: string): TicketPageCursor {
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const asOf = new Date(String(value.a));
    if (
      Number.isNaN(asOf.getTime()) ||
      (value.b !== 0 && value.b !== 1) ||
      typeof value.k !== 'string' ||
      !/^-?\d+(\.\d+)?$/.test(value.k) ||
      typeof value.i !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.i)
    ) {
      throw new Error('cursor');
    }
    return { asOf, bucket: value.b, sortKey: value.k, ticketId: value.i };
  } catch {
    throw new BookingFlowError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'cursor',
        rejectedValue: undefined,
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
  }
}
