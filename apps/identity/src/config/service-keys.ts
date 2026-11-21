/**
 * The credential booking must present to resolve a hold's passengers. Read per
 * call so a test that stubs the environment is honoured.
 */
export function bookingIdentityServiceKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.BOOKING_IDENTITY_SERVICE_KEY;
}
