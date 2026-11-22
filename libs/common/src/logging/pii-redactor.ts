const SENSITIVE_KEY_REGEX =
  /password|secret|token|pin|code|verification.?code|card.?number|cvv|national.?id|phone|service.?key|x-booking-.*-key|x-gateway-booking-key|full.?name|display.?name|passenger.?name/i;

const EMAIL_REGEX =
  /\b([a-zA-Z0-9_.+-])[a-zA-Z0-9_.+-]*@([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\b/g;

/** Masks email usernames, keeping the first character and domain. */
export function maskEmail(email: string): string {
  return email.replace(EMAIL_REGEX, '$1***@$2');
}

/** Masks emails and redacts sensitive keys recursively. */
export function redactPii<T>(
  data: T,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Validation/driver errors may embed a National ID without its field name.
    return maskEmail(data)
      .replace(
        /(?<![0-9\u0660-\u0669])[0-9\u0660-\u0669]{14}(?![0-9\u0660-\u0669])/g,
        '[REDACTED]',
      )
      .replace(/\*{10}[0-9]{4}|\b[a-f0-9]{64}\b/gi, '[REDACTED]')
      .replace(/sk_(?:test|live)_[a-zA-Z0-9]+/g, '[REDACTED]')
      .replace(/whsec_[a-zA-Z0-9]+/g, '[REDACTED]')
      .replace(
        /(?:seti|pi)_[a-zA-Z0-9]+_secret_[a-zA-Z0-9]+/g,
        '[REDACTED]',
      ) as unknown as T;
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
