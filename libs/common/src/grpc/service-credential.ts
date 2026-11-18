import { timingSafeEqual } from 'node:crypto';

/** Missing configuration and repeated headers fail closed without logging secrets. */
export function matchesServiceCredential(
  actual: unknown,
  expected: string | undefined,
): boolean {
  if (
    typeof actual !== 'string' ||
    typeof expected !== 'string' ||
    expected.length < 32
  ) {
    return false;
  }
  const received = Buffer.from(actual);
  const configured = Buffer.from(expected);
  return (
    received.length === configured.length &&
    timingSafeEqual(received, configured)
  );
}
