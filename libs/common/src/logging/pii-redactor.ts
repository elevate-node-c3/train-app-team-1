const SENSITIVE_KEY_REGEX =
  /password|secret|token|pin|code|verification.?code|card.?number|cvv|national.?id|phone/i;

const EMAIL_REGEX =
  /\b([a-zA-Z0-9_.+-])[a-zA-Z0-9_.+-]*@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\b/g;

/**
 * Masks an email string: e.g. "john.doe@example.com" -> "j***@example.com"
 */
export function maskEmail(email: string): string {
  return email.replace(EMAIL_REGEX, '$1***@$2');
}

/**
 * Deeply sanitizes any object, array, or primitive, masking personal data and credentials.
 */
export function redactPii<T>(
  data: T,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return maskEmail(data) as unknown as T;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (depth > 6) {
    return data;
  }

  if (seen.has(data as object)) {
    return '[CIRCULAR]' as unknown as T;
  }
  seen.add(data as object);

  if (Array.isArray(data)) {
    return data.map((item) => redactPii(item, seen, depth + 1)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactPii(value, seen, depth + 1);
    }
  }
  return result as T;
}
