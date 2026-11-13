import { randomUUID } from 'node:crypto';

import type { ApiResponse, VerifyEmailResponseDto } from '@app/contracts';

import { renderVerificationEmail } from '../../../apps/notification/src/modules/verification-emails/verification-email.template.js';

import {
  AUTH_BASE_URL,
  GATEWAY_URL,
  clearMailpit,
  compose,
  composeUpBuild,
  signUp,
  waitForEmailCode,
} from './stack.js';

/**
 * Real traveller tokens need identity -> rabbitmq -> notification -> mailpit
 * to deliver the verification code. Without notification, sign-up succeeds
 * but verification cannot complete.
 */
export const SEARCH_STACK = [
  'postgres',
  'redis',
  'rabbitmq',
  'mailpit',
  'gateway',
  'identity',
  'notification',
  'catalog',
] as const;

export const TRIPS_URL = `${GATEWAY_URL}/api/v1/trips`;
export const TRIPS_SEARCH_URL = `${TRIPS_URL}/search`;

/**
 * Use notification's template to avoid subject drift and email-wait timeouts.
 * The code is only in the body, so its value does not affect the subject.
 */
export const SIGN_UP_SUBJECT = renderVerificationEmail({
  code: '000000',
  language: 'en',
}).subject;

export function startSearchStack(): void {
  compose('down', '-v', '--remove-orphans');
  composeUpBuild(SEARCH_STACK);
}

/** Obtain a real token through sign-up, Mailpit and verification, not a fake. */
export async function travellerAccessToken(): Promise<string> {
  await clearMailpit();
  const email = `search-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;

  const created = await signUp(email, 'en');
  if (created.status !== 201) {
    throw new Error(`sign-up failed: ${JSON.stringify(created.body)}`);
  }

  const code = await waitForEmailCode(email, SIGN_UP_SUBJECT);

  const response = await fetch(`${AUTH_BASE_URL}/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const body = (await response.json()) as ApiResponse<VerifyEmailResponseDto>;

  // HTTP flattens TokenPairDto; unlike the proto, it has no `tokens` wrapper.
  const token = body.data?.accessToken;
  if (!token) {
    throw new Error(`verify-email returned no token: ${JSON.stringify(body)}`);
  }
  return token;
}

export interface SearchQuery {
  from?: string;
  to?: string;
  departureDate?: string;
  travelClassId?: string;
  trainNumber?: string;
  language?: string;
  /** A return date selects a round trip. */
  returnDate?: string;
  sort?: string;
  trainTypeIds?: string;
  departAfter?: string;
  departBefore?: string;
  maxFare?: string;
  excludeSoldOut?: string;
}

export interface ReturnSearchQuery {
  outboundTripId?: string;
  outboundFrom?: string;
  outboundTo?: string;
  returnDate?: string;
  travelClassId?: string;
  sort?: string;
  maxFare?: string;
}

export interface CallOptions {
  token?: string;
  acceptLanguage?: string;
}

interface Called {
  status: number;
  body: ApiResponse<unknown>;
}

/** Share correlation, bearer and language headers across all route helpers. */
async function get(url: URL, options: CallOptions = {}): Promise<Called> {
  const response = await fetch(url, {
    headers: {
      'x-correlation-id': `e2e-search-${randomUUID()}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.acceptLanguage
        ? { 'accept-language': options.acceptLanguage }
        : {}),
    },
  });

  return {
    status: response.status,
    body: (await response.json()) as ApiResponse<unknown>,
  };
}

/** Omit absent parameters instead of sending 'undefined'. */
function urlWith(base: string, query: object): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') url.searchParams.set(key, value);
  }
  return url;
}

export async function searchTrips(
  query: SearchQuery,
  options: CallOptions = {},
): Promise<Called> {
  return get(urlWith(TRIPS_SEARCH_URL, query), options);
}

/** Return trips for a chosen outbound trip. */
export async function searchReturnTrips(
  query: ReturnSearchQuery,
  options: CallOptions = {},
): Promise<Called> {
  return get(urlWith(`${TRIPS_SEARCH_URL}/return`, query), options);
}

export async function tripStops(
  tripId: string,
  query: { from?: string; to?: string },
  options: CallOptions = {},
): Promise<Called> {
  return get(urlWith(`${TRIPS_URL}/${tripId}/stops`, query), options);
}

export async function recentSearches(
  options: CallOptions = {},
): Promise<Called> {
  return get(urlWith(`${TRIPS_URL}/recent-searches`, {}), options);
}
