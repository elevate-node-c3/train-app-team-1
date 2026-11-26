import { getProtoPath } from '../proto-path.js';
import type { SupportedLanguage } from '../events/event-envelope.js';

export const IDENTITY_PACKAGE_NAME = 'train.identity.v1';
export const IDENTITY_SERVICE_NAME = 'IdentityService';

/** Private notification directory lookup; no profile or credential data. */
export interface ResolveNotificationRecipientRequest {
  accountId: string;
}

export interface ResolveNotificationRecipientResponse {
  email: string;
  /** The account's stored language (never a request header); '' with no recipient. */
  language: SupportedLanguage | '';
}

/** Resolves identity.proto across the source, dist and container layouts. */
export function getIdentityProtoPath(): string {
  return getProtoPath('identity.proto');
}
