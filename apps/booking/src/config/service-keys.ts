/**
 * The credentials booking presents on the two private transports it calls.
 * Read per call so a test that stubs the environment is honoured.
 */
export type BookingCallTarget = 'inventory' | 'identity';

export function serviceKeyFor(
  target: BookingCallTarget,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return target === 'inventory'
    ? env.BOOKING_INVENTORY_SERVICE_KEY
    : env.BOOKING_IDENTITY_SERVICE_KEY;
}
