import { describe, expect, it } from 'vitest';

import {
  calculateHoldExpiry,
  calculateHoldExtension,
  EXTENSION_DURATION_MS,
  HoldExpiryError,
  type HoldExpiryErrorCode,
} from './hold-expiry.policy.js';

const MINUTE_MS = 60 * 1000;

function at(iso: string): Date {
  return new Date(iso);
}

function expectHoldExpiryError(
  run: () => unknown,
  code: HoldExpiryErrorCode,
): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HoldExpiryError);
    expect((error as HoldExpiryError).code).toBe(code);
    return;
  }

  throw new Error(`Expected HoldExpiryError with code ${code}.`);
}

describe('calculateHoldExpiry', () => {
  it('keeps a hold for 15 minutes when sales stay open longer', () => {
    const now = at('2026-01-15T10:00:00.000Z');

    const expiresAt = calculateHoldExpiry({
      now,
      originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
    });

    expect(expiresAt).toEqual(new Date(now.getTime() + 15 * MINUTE_MS));
  });

  it('expires at the sales cutoff when it is earlier than 15 minutes', () => {
    const now = at('2026-01-15T10:00:00.000Z');

    const expiresAt = calculateHoldExpiry({
      now,
      originDepartureTimes: [at('2026-01-15T10:20:00.000Z')],
    });

    expect(expiresAt).toEqual(at('2026-01-15T10:05:00.000Z'));
  });

  it('uses the earliest cutoff across multiple legs', () => {
    const now = at('2026-01-15T10:00:00.000Z');

    const expiresAt = calculateHoldExpiry({
      now,
      originDepartureTimes: [
        at('2026-01-15T10:20:00.000Z'),
        at('2026-01-15T10:18:00.000Z'),
      ],
    });

    expect(expiresAt).toEqual(at('2026-01-15T10:03:00.000Z'));
  });

  it('rejects a hold when departure is only 14 minutes away', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: at('2026-01-15T10:00:00.000Z'),
          originDepartureTimes: [at('2026-01-15T10:14:00.000Z')],
        }),
      'SALES_CLOSED',
    );
  });

  it('rejects a hold when any leg has already closed', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: at('2026-01-15T10:00:00.000Z'),
          originDepartureTimes: [
            at('2026-01-15T12:00:00.000Z'),
            at('2026-01-15T10:14:00.000Z'),
          ],
        }),
      'SALES_CLOSED',
    );
  });

  it('rejects a hold when the sales cutoff is exactly now', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: at('2026-01-15T10:05:00.000Z'),
          originDepartureTimes: [at('2026-01-15T10:20:00.000Z')],
        }),
      'SALES_CLOSED',
    );
  });

  it('rejects an invalid current time', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: new Date('not-a-date'),
          originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
        }),
      'INVALID_CURRENT_TIME',
    );
  });

  it('rejects an invalid passenger origin departure time', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: at('2026-01-15T10:00:00.000Z'),
          originDepartureTimes: [new Date('not-a-date')],
        }),
      'INVALID_DEPARTURE_TIME',
    );
  });

  it('rejects an empty departure list', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExpiry({
          now: at('2026-01-15T10:00:00.000Z'),
          originDepartureTimes: [],
        }),
      'NO_ORIGIN_DEPARTURES',
    );
  });
});

describe('calculateHoldExtension', () => {
  it('adds the full five minutes when the sale stays open', () => {
    const extended = calculateHoldExtension({
      now: at('2026-01-15T10:05:00.000Z'),
      expiresAt: at('2026-01-15T10:15:00.000Z'),
      originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
    });

    expect(extended).toEqual(
      new Date(
        at('2026-01-15T10:15:00.000Z').getTime() + EXTENSION_DURATION_MS,
      ),
    );
  });

  it('caps the extension at the earliest current sales cutoff', () => {
    const extended = calculateHoldExtension({
      now: at('2026-01-15T10:05:00.000Z'),
      expiresAt: at('2026-01-15T10:15:00.000Z'),
      originDepartureTimes: [
        at('2026-01-15T10:40:00.000Z'),
        at('2026-01-15T10:32:00.000Z'),
      ],
    });

    expect(extended).toEqual(at('2026-01-15T10:17:00.000Z'));
  });

  it('returns null when the hold already ends at the sales cutoff', () => {
    const extended = calculateHoldExtension({
      now: at('2026-01-15T10:05:00.000Z'),
      expiresAt: at('2026-01-15T10:15:00.000Z'),
      originDepartureTimes: [at('2026-01-15T10:30:00.000Z')],
    });

    expect(extended).toBeNull();
  });

  it('returns null when the current cutoff is already earlier than expiry', () => {
    const extended = calculateHoldExtension({
      now: at('2026-01-15T10:05:00.000Z'),
      expiresAt: at('2026-01-15T10:15:00.000Z'),
      originDepartureTimes: [at('2026-01-15T10:20:00.000Z')],
    });

    expect(extended).toBeNull();
  });

  it('refuses to extend an expired hold', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExtension({
          now: at('2026-01-15T10:15:00.000Z'),
          expiresAt: at('2026-01-15T10:15:00.000Z'),
          originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
        }),
      'HOLD_EXPIRED',
    );
  });

  it('rejects an invalid expiry', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExtension({
          now: at('2026-01-15T10:05:00.000Z'),
          expiresAt: new Date('not-a-date'),
          originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
        }),
      'INVALID_EXPIRY_TIME',
    );
  });

  it('rejects an invalid current time', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExtension({
          now: new Date('not-a-date'),
          expiresAt: at('2026-01-15T10:15:00.000Z'),
          originDepartureTimes: [at('2026-01-15T12:00:00.000Z')],
        }),
      'INVALID_CURRENT_TIME',
    );
  });

  it('rejects an empty departure list', () => {
    expectHoldExpiryError(
      () =>
        calculateHoldExtension({
          now: at('2026-01-15T10:05:00.000Z'),
          expiresAt: at('2026-01-15T10:15:00.000Z'),
          originDepartureTimes: [],
        }),
      'NO_ORIGIN_DEPARTURES',
    );
  });
});
