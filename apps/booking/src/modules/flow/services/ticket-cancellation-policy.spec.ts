import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { quoteCancellation, type CancellationPolicyInput } from './ticket-cancellation-policy.js';

describe('quoteCancellation', () => {
  const fare = 15500; // 155 EGP
  const base = (deltaMs: number, overrides: Partial<CancellationPolicyInput> = {}) => ({
    departsAt: new Date(Date.UTC(2026, 11, 1, 12, 0, 0)),
    now: new Date(Date.UTC(2026, 11, 1, 12, 0, 0) - deltaMs),
    farePiastres: fare,
    delayMinutes: 0,
    tripCancelled: false,
    ...overrides,
  });

  it('gives 100% at exactly 24h00m00s before boarding', () => {
    expect(quoteCancellation(base(24 * 3600_000))).toEqual({ allowed: true, tier: 'FULL', refundPiastres: 15500 });
  });
  it('gives 50% at 23h59m59s before boarding', () => {
    expect(quoteCancellation(base(24 * 3600_000 - 1000))).toEqual({ allowed: true, tier: 'HALF', refundPiastres: 7750 });
  });
  it('gives 50% at exactly 2h00m00s before boarding', () => {
    expect(quoteCancellation(base(2 * 3600_000))).toEqual({ allowed: true, tier: 'HALF', refundPiastres: 7750 });
  });
  it('refuses at 1h59m59s before boarding', () => {
    expect(quoteCancellation(base(2 * 3600_000 - 1000))).toEqual({ allowed: false, code: ErrorCode.CANCELLATION_WINDOW_CLOSED });
  });
  it('refuses after departure', () => {
    expect(quoteCancellation(base(-1000))).toEqual({ allowed: false, code: ErrorCode.CANCELLATION_WINDOW_CLOSED });
  });
  it('gives 100% when delayed 60+ minutes, even inside the last 2 hours (BR-49)', () => {
    expect(quoteCancellation(base(30 * 60_000, { delayMinutes: 60 }))).toEqual({ allowed: true, tier: 'FULL', refundPiastres: 15500 });
  });
  it('gives 100% when the trip is cancelled (BR-48)', () => {
    expect(quoteCancellation(base(30 * 60_000, { tripCancelled: true }))).toEqual({ allowed: true, tier: 'FULL', refundPiastres: 15500 });
  });
  it('rounds half-up in the passenger\'s favor at 50%', () => {
    expect(quoteCancellation(base(6 * 3600_000, { farePiastres: 15501 }))).toEqual({ allowed: true, tier: 'HALF', refundPiastres: 7751 });
  });
});
