import {
  DEFAULT_EVENT_RETRY_DELAYS_MS,
  NOTIFICATION_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import type { EventSubscription } from './event-subscription.js';

/** A subscription's own delays win; the variable is the platform default. */
export function retryDelaysFor(
  subscription: EventSubscription,
): readonly number[] {
  if (subscription.retryDelaysMs) {
    return subscription.retryDelaysMs;
  }

  const raw =
    process.env.EVENT_RETRY_DELAYS_MS ?? NOTIFICATION_DEFAULTS.retryDelays;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);

  return parsed.length > 0 ? parsed : DEFAULT_EVENT_RETRY_DELAYS_MS;
}

export function handlerTimeoutMs(): number {
  const raw = Number(process.env.EVENT_HANDLER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : NOTIFICATION_DEFAULTS.handlerTimeoutMs;
}

export function prefetchSize(): number {
  const raw = Number(process.env.EVENT_PREFETCH);
  return Number.isInteger(raw) && raw > 0 ? raw : NOTIFICATION_DEFAULTS.prefetch;
}

export function claimLeaseSeconds(): number {
  const raw = Number(process.env.EVENT_CLAIM_LEASE_SECONDS);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : NOTIFICATION_DEFAULTS.claimLeaseSeconds;
}
