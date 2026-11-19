import { isValidationIssueRef, type ValidationIssueRef } from '@app/contracts';

import { isErrorCode, type ServiceRefusal } from './service-refusal.js';

/**
 * Recover the refusal a service sent, from whichever side of the call we are
 * on: a gRPC ServiceError carries it as a `details` string, an RpcException
 * hands it back through getError(), and a caller may pass the string itself.
 *
 * Returns null when this is not a refusal, which means the status alone has to
 * answer. Nothing here is trusted: an unknown code, a malformed detail or a
 * service-authored sentence is dropped rather than passed on to a caller.
 */
export function decodeRefusal(source: unknown): ServiceRefusal | null {
  const raw = refusalDetails(source);
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (!isErrorCode(record.code)) return null;

  const retryAfterSeconds = record.retryAfterSeconds;
  return {
    code: record.code,
    details: Array.isArray(record.details)
      ? record.details.filter(isValidationIssueRef)
      : [],
    ...(typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.ceil(retryAfterSeconds) }
      : {}),
  };
}

/** The details a refusal may be hiding in, whatever wrapped it. */
function refusalDetails(source: unknown): unknown {
  if (typeof source === 'string') return source;
  if (typeof source !== 'object' || source === null) return undefined;

  const unwrapped =
    typeof (source as { getError?: unknown }).getError === 'function'
      ? (source as { getError: () => unknown }).getError()
      : source;

  if (typeof unwrapped === 'string') return unwrapped;
  if (typeof unwrapped !== 'object' || unwrapped === null) return undefined;
  return (unwrapped as { details?: unknown }).details;
}

/** The field-level refs a refusal carries, or none. */
export function refusalDetailRefs(source: unknown): ValidationIssueRef[] {
  return decodeRefusal(source)?.details ?? [];
}
