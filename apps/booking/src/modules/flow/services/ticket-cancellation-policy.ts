import { ErrorCode } from '@app/contracts';

export type CancellationTier = 'FULL' | 'HALF';

export type CancellationQuote =
  | { allowed: true; tier: CancellationTier; refundPiastres: number }
  | { allowed: false; code: ErrorCode.CANCELLATION_WINDOW_CLOSED };

export interface CancellationPolicyInput {
  departsAt: Date;
  now: Date;
  farePiastres: number;
  /** Sprint 5 input (BR-49a); always 0 this sprint. */
  delayMinutes: number;
  /** Sprint 5 input (BR-48); always false this sprint. */
  tripCancelled: boolean;
}

const HOUR_MS = 3_600_000;

function allowed(
  tier: CancellationTier,
  farePiastres: number,
): CancellationQuote {
  // Math.round takes .5 up, which favours the passenger.
  const refundPiastres = Math.round(farePiastres * (tier === 'FULL' ? 1 : 0.5));
  return { allowed: true, tier, refundPiastres };
}

export function quoteCancellation(
  input: CancellationPolicyInput,
): CancellationQuote {
  const refused: CancellationQuote = {
    allowed: false,
    code: ErrorCode.CANCELLATION_WINDOW_CLOSED,
  };

  // Cancellation and long delays win regardless of the clock.
  if (input.tripCancelled || input.delayMinutes >= 60) {
    return allowed('FULL', input.farePiastres);
  }

  // Absolute instants only; a delay moves boarding later.
  const msUntilBoarding =
    input.departsAt.getTime() -
    input.now.getTime() +
    input.delayMinutes * 60_000;

  if (msUntilBoarding <= 0) return refused;
  if (msUntilBoarding >= 24 * HOUR_MS) {
    return allowed('FULL', input.farePiastres);
  }
  if (msUntilBoarding >= 2 * HOUR_MS) {
    return allowed('HALF', input.farePiastres);
  }
  return refused;
}
