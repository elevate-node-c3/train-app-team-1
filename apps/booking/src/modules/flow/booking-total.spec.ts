import { describe, expect, it } from 'vitest';
import {
  BOOKING_CURRENCY,
  BOOKING_FEE_PERCENT,
  bookingFeePiastres,
  priceBooking,
} from './booking-total.js';

describe('booking fee and total (BR-31)', () => {
  it('charges 7% in EGP piastres', () => {
    expect(BOOKING_FEE_PERCENT).toBe(7);
    expect(BOOKING_CURRENCY).toBe('EGP');
  });

  it('one passenger on a 65 EGP fare: Price 6500, Booking Fee 455, Total 6955', () => {
    expect(priceBooking([6_500], 1)).toEqual({
      fareTotalPiastres: 6_500,
      bookingFeePiastres: 455,
      totalPiastres: 6_955,
    });
  });

  it('three passengers at 10.50 EGP: fee 221 on the combined 3150, total 3371', () => {
    expect(priceBooking([1_050], 3)).toEqual({
      fareTotalPiastres: 3_150,
      bookingFeePiastres: 221,
      totalPiastres: 3_371,
    });
  });

  it('shows the per-ticket method would have produced 222, which BR-31 forbids', () => {
    const perTicket = bookingFeePiastres(1_050) * 3;
    expect(bookingFeePiastres(1_050)).toBe(74); // 73.5 rounded half-up
    expect(perTicket).toBe(222);
    expect(priceBooking([1_050], 3).bookingFeePiastres).toBe(221);
  });

  it('rounds exactly half a piastre up and anything less down', () => {
    expect(bookingFeePiastres(50)).toBe(4); // 3.5 → 4
    expect(bookingFeePiastres(49)).toBe(3); // 3.43 → 3
    expect(bookingFeePiastres(0)).toBe(0);
  });

  it('computes one fee across every passenger on both legs of a round trip', () => {
    // 2 passengers × (4000 + 6000) = 20000 → fee 1400, total 21400.
    expect(priceBooking([4_000, 6_000], 2)).toEqual({
      fareTotalPiastres: 20_000,
      bookingFeePiastres: 1_400,
      totalPiastres: 21_400,
    });
    // One fee on the sum, not one per leg: 1050 + 1050 = 2100 → 147,
    // whereas a fee per leg would be 74 + 74 = 148.
    expect(priceBooking([1_050, 1_050], 1).bookingFeePiastres).toBe(147);
    expect(bookingFeePiastres(1_050) * 2).toBe(148);
  });

  it('rejects unsafe or out-of-range amounts', () => {
    expect(() => bookingFeePiastres(-1)).toThrow();
    expect(() => priceBooking([-1], 1)).toThrow();
    expect(() => priceBooking([Number.MAX_SAFE_INTEGER], 1)).toThrow();
    expect(() => priceBooking([2_147_483_647], 1)).toThrow();
    expect(() => priceBooking([0], 1)).toThrow();
  });
});
