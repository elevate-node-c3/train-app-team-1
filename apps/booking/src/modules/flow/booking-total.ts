import { FARE_CURRENCY } from '@app/contracts';

/**
 * The one home of the booking fee and total (BR-31). Payment receives the
 * total and never recomputes it; refunds will use this file too.
 */
export const BOOKING_FEE_PERCENT = 7;

export const BOOKING_CURRENCY = FARE_CURRENCY;

const MAX_PIASTRES = 2_147_483_647; // int32 on the wire

export interface BookingPrice {
  fareTotalPiastres: number;
  bookingFeePiastres: number;
  totalPiastres: number;
}

/**
 * Fee on the combined fare of every passenger on every leg, rounded half-up
 * to the piastre once — never per ticket. Integer arithmetic, no floats:
 * 3 × 1050 = 3150 → 220.5 → 221, where per-ticket rounding gives 3 × 74 = 222.
 */
export function bookingFeePiastres(fareTotalPiastres: number): number {
  if (!Number.isSafeInteger(fareTotalPiastres) || fareTotalPiastres < 0) {
    throw new Error('Catalog returned an invalid fare total');
  }
  return Math.floor((fareTotalPiastres * BOOKING_FEE_PERCENT + 50) / 100);
}

/** Price `passengerCount` passengers on legs whose one-passenger fares are given. */
export function priceBooking(
  legFaresPiastres: readonly number[],
  passengerCount: number,
): BookingPrice {
  if (legFaresPiastres.some((fare) => !Number.isSafeInteger(fare) || fare < 0)) {
    throw new Error('Catalog returned an invalid fare');
  }
  const fareTotalPiastres =
    legFaresPiastres.reduce((sum, fare) => sum + fare, 0) * passengerCount;
  const fee = bookingFeePiastres(fareTotalPiastres);
  const totalPiastres = fareTotalPiastres + fee;
  if (
    !Number.isSafeInteger(totalPiastres) ||
    totalPiastres < 1 ||
    totalPiastres > MAX_PIASTRES
  ) {
    throw new Error('Booking total exceeds the supported amount');
  }
  return { fareTotalPiastres, bookingFeePiastres: fee, totalPiastres };
}
