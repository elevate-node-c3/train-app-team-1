import type { EventLanguage } from './events/event-envelope.js';
import { getProtoPath } from './proto-path.js';

export const ACCOUNTS_PACKAGE_NAME = 'train.accounts.v1';
export const ACCOUNTS_SERVICE_NAME = 'AccountsService';

/** Resolves accounts.proto across the source, dist and container layouts. */
export function getAccountsProtoPath(): string {
  return getProtoPath('accounts.proto');
}

export interface SignUpRequestDto {
  email: string;
  /** Plaintext only for the duration of the call; identity hashes it at once. */
  password: string;
  /**
   * Optional on the wire because the gRPC caller may omit it; identity then
   * defaults the account to Arabic, the platform fallback (BR-56).
   */
  language?: EventLanguage;
}
