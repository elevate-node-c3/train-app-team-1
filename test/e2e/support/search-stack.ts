import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ApiResponse, VerifyEmailResponseDto } from '@app/contracts';

import { renderVerificationEmail } from '../../../apps/notification/src/modules/verification-emails/verification-email.template.js';

import {
  AUTH_BASE_URL,
  clearMailpit,
  compose,
  signUp,
  waitForEmailCode,
} from './stack.js';

/**
 * The slice of the stack a search needs.
 *
 * Four of these are here only because a verified traveller is. The token comes
 * from signing up and reading the verification code out of the inbox, and that
 * code travels identity -> rabbitmq -> notification -> mailpit. Leaving
 * notification out is a silent failure: sign-up still succeeds, the event is
 * still published, and the email simply never arrives.
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

const BUILD_TIMEOUT_MS = 20 * 60_000;

export const TRIPS_SEARCH_URL = `${process.env.GATEWAY_URL ?? 'http://localhost:3000'}/api/v1/trips/search`;

/**
 * The subject the notification service actually sends, asked of the template
 * that owns it rather than restated here.
 *
 * Hardcoding it is how the first two runs of this spec failed: the string was
 * plausible, wrong, and produced a 90-second timeout with no hint that the
 * subject was the problem. The code argument is irrelevant -- it appears in
 * the body only, never the subject.
 */
export const SIGN_UP_SUBJECT = renderVerificationEmail({
  code: '000000',
  language: 'en',
}).subject;

export function startSearchStack(): void {
  compose('down', '-v', '--remove-orphans');
  execFileSync(
    'docker',
    [
      'compose',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '600',
      ...SEARCH_STACK,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: BUILD_TIMEOUT_MS },
  );
}

/**
 * A verified traveller's access token.
 *
 * The long way round on purpose: there is no shortcut that proves the route is
 * reachable by a real traveller. Sign up, read the code out of Mailpit, verify,
 * and the tokens come back from that call.
 */
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

  // VerifyEmailResponseDto extends TokenPairDto, so the pair is flattened onto
  // the response rather than nested under `tokens` as the proto has it.
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
}

/** Calls the endpoint the way a client would. */
export async function searchTrips(
  query: SearchQuery,
  options: { token?: string; acceptLanguage?: string } = {},
): Promise<{ status: number; body: ApiResponse<unknown> }> {
  const url = new URL(TRIPS_SEARCH_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

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
