import type { AccessLevel } from '@app/contracts';
import type { Account } from '../domain/account.js';

/**
 * The level a freshly minted token carries. Only a verified account can reach
 * this function, so `public` never appears here; staff roles are orthogonal to
 * the ladder and stay in the `roles` claim.
 */
export function accessLevelOf(account: Account): AccessLevel {
  if (!account.isVerified()) {
    throw new Error('Cannot mint an access token for an unverified account');
  }
  return account.bookable ? 'bookable' : 'traveller';
}
