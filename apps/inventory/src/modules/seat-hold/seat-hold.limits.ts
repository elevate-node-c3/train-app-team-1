/**
 * The bounds of a hold request. The DTO and HoldCoreService both read them
 * here, so a request the pipe accepts is one the service accepts.
 */

/** A round trip, so two legs. */
export const MAX_LEGS = 2;

/** BR-28: four travellers to a booking. */
export const MAX_PASSENGERS = 4;

export const MAX_BOOKING_KEY_LENGTH = 200;
export const MAX_PASSENGER_REF_LENGTH = 200;
export const MAX_PASSENGER_TOKEN_LENGTH = 1024;
