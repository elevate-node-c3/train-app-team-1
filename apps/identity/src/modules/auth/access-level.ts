import type { AccessLevel } from '@app/contracts';
import type { AccountEntity } from './entities/account.entity.js';

/**
 * Only verified accounts get traveller/bookable tokens, never public tokens.
 * Staff roles remain in the separate roles claim.
 */
export function accessLevelOf(account: AccountEntity): AccessLevel {
  if (account.emailVerifiedAt === null) {
    throw new Error('Cannot mint an access token for an unverified account');
  }
  return account.bookable ? 'bookable' : 'traveller';
}
