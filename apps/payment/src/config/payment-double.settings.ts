export function paymentDoubleSucceededBookingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set(
    (env.PAYMENT_DOUBLE_SUCCEEDED_BOOKINGS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}
