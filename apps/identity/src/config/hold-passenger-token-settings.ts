export const HOLD_PASSENGER_TOKEN_SETTINGS = Symbol(
  'HOLD_PASSENGER_TOKEN_SETTINGS',
);

export interface HoldPassengerTokenSettings {
  readonly activeVersion: number | null;
  readonly keys: ReadonlyMap<number, Buffer>;
}

/** No fallback to JWT, service credentials, or development secrets. */
export function holdPassengerTokenSettingsFromEnv(
  env: Readonly<Record<string, unknown>> = process.env,
): HoldPassengerTokenSettings {
  const rawKeys = env.HOLD_PASSENGER_TOKEN_KEYS;
  const rawVersion = env.HOLD_PASSENGER_TOKEN_ACTIVE_VERSION;
  if (
    (rawKeys === undefined || rawKeys === '') &&
    (rawVersion === undefined || rawVersion === '')
  ) {
    return { activeVersion: null, keys: new Map() };
  }

  try {
    if (
      typeof rawKeys !== 'string' ||
      typeof rawVersion !== 'string' ||
      !/^[1-9]\d*$/.test(rawVersion)
    ) {
      throw new Error();
    }
    const activeVersion = Number(rawVersion);
    if (!Number.isSafeInteger(activeVersion) || activeVersion > 2_147_483_647) {
      throw new Error();
    }
    const parsed: unknown = JSON.parse(rawKeys);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error();
    }

    const keys = new Map<number, Buffer>();
    for (const [version, value] of Object.entries(parsed)) {
      if (
        !/^[1-9]\d*$/.test(version) ||
        !Number.isSafeInteger(Number(version)) ||
        Number(version) > 2_147_483_647 ||
        typeof value !== 'string'
      ) {
        throw new Error();
      }
      const key = Buffer.from(value, 'base64');
      // Buffer's decoder accepts malformed input; require canonical base64.
      if (key.length < 32 || key.toString('base64') !== value) {
        throw new Error();
      }
      keys.set(Number(version), key);
    }
    if (!keys.has(activeVersion)) throw new Error();
    return { activeVersion, keys };
  } catch {
    // JSON parser errors can contain secrets from the original input.
    throw new Error(
      'Invalid HOLD_PASSENGER_TOKEN_KEYS / HOLD_PASSENGER_TOKEN_ACTIVE_VERSION configuration',
    );
  }
}
