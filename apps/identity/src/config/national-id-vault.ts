import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type { ValueTransformer } from 'typeorm';

const PREFIX = 'nid:v1';
type NationalIdScope = 'account' | 'passenger';

interface VaultSettings {
  activeVersion: number;
  keys: Map<number, Buffer>;
  blindIndexKey: Buffer;
}

function decodedKey(value: unknown, name: string): Buffer {
  if (typeof value !== 'string') throw new Error(`${name} is not configured`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32)
    throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

function settings(): VaultSettings {
  const activeVersion = Number(process.env.NATIONAL_ID_ACTIVE_KEY_VERSION);
  if (!Number.isSafeInteger(activeVersion) || activeVersion < 1)
    throw new Error('NATIONAL_ID_ACTIVE_KEY_VERSION is not configured');
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.NATIONAL_ID_ENCRYPTION_KEYS ?? '');
  } catch {
    throw new Error('NATIONAL_ID_ENCRYPTION_KEYS is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('NATIONAL_ID_ENCRYPTION_KEYS is invalid');
  const keys = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(parsed)) {
    if (!/^[1-9]\d*$/.test(version))
      throw new Error('National-ID key version is invalid');
    keys.set(
      Number(version),
      decodedKey(value, `National-ID encryption key ${version}`),
    );
  }
  if (!keys.has(activeVersion))
    throw new Error('Active National-ID encryption key is missing');
  return {
    activeVersion,
    keys,
    blindIndexKey: decodedKey(
      process.env.NATIONAL_ID_BLIND_INDEX_KEY,
      'NATIONAL_ID_BLIND_INDEX_KEY',
    ),
  };
}

/** The validator owns semantic checks; storage normalizes digits for equality. */
export function canonicalNationalId(value: string): string {
  return value
    .trim()
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660));
}

export function nationalIdBlindIndex(value: string): string {
  return createHmac('sha256', settings().blindIndexKey)
    .update(`identity:national-id:v1\0${canonicalNationalId(value)}`)
    .digest('hex');
}

export function encryptNationalId(
  value: string,
  scope: NationalIdScope,
): string {
  const config = settings();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    config.keys.get(config.activeVersion)!,
    iv,
  );
  cipher.setAAD(Buffer.from(`identity:national-id:v1:${scope}`));
  const encrypted = Buffer.concat([
    cipher.update(canonicalNationalId(value), 'utf8'),
    cipher.final(),
  ]);
  return [
    PREFIX,
    String(config.activeVersion),
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptNationalId(
  value: string,
  scope: NationalIdScope,
): string {
  const [prefix, format, versionRaw, ivRaw, tagRaw, encryptedRaw, extra] =
    value.split(':');
  if (`${prefix}:${format}` !== PREFIX || extra !== undefined)
    throw new Error('Stored National ID is not encrypted');
  const version = Number(versionRaw);
  const key = settings().keys.get(version);
  if (!key) throw new Error('Stored National-ID key version is unavailable');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`identity:national-id:v1:${scope}`));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Stored National ID failed authentication');
  }
}

export function nationalIdTransformer(
  scope: NationalIdScope,
): ValueTransformer {
  return {
    to: (value: string | null) =>
      value === null ? null : encryptNationalId(value, scope),
    from: (value: string | null) =>
      value === null ? null : decryptNationalId(value, scope),
  };
}

export function validateNationalIdVaultEnvironment(): void {
  settings();
}
