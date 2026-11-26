import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface TicketPublicKeySetting {
  kid: string;
  publicKeyPem: string;
}

/**
 * Booking's ticket signing key (BR-38, D11). The private half never leaves
 * booking; conductors only ever receive public keys.
 *
 * Rotation: give the new key a new `TICKET_SIGNING_KEY_ID`, and move the old
 * key's public half into `TICKET_RETIRED_PUBLIC_KEYS`. Every QR names its key,
 * so tickets the old key signed keep verifying for as long as it is listed.
 */
export interface TicketSigningSettings {
  keyId: string;
  privateKeyPem: string;
  retiredPublicKeys: TicketPublicKeySetting[];
}

/** Loaded once in onModuleInit, like identity's JWT key; there is no default key. */
export function ticketSigningSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TicketSigningSettings {
  return {
    keyId: env.TICKET_SIGNING_KEY_ID?.trim() || 'ticket-dev-1',
    privateKeyPem: privateKeyPemFromEnv(env),
    retiredPublicKeys: retiredPublicKeysFromEnv(env),
  };
}

function privateKeyPemFromEnv(env: NodeJS.ProcessEnv): string {
  const inline = env.TICKET_SIGNING_PRIVATE_KEY;
  if (inline && inline.trim().length > 0) {
    return inline.replace(/\\n/g, '\n');
  }

  const file = env.TICKET_SIGNING_PRIVATE_KEY_FILE;
  if (!file) {
    throw new Error(
      "Missing required environment variable 'TICKET_SIGNING_PRIVATE_KEY' or 'TICKET_SIGNING_PRIVATE_KEY_FILE'; run 'npm run keys:generate' for a development key",
    );
  }

  const path = resolve(file);
  if (!existsSync(path)) {
    throw new Error(
      `TICKET_SIGNING_PRIVATE_KEY_FILE points to a missing private key file: ${file}`,
    );
  }
  if (statSync(path).isDirectory()) {
    throw new Error(
      `TICKET_SIGNING_PRIVATE_KEY_FILE points to a directory, not a file: ${file}. If you started Docker before generating keys, run 'npm run keys:generate' and restart Docker.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/** A JSON object of key id to public PEM, e.g. {"ticket-2026-1":"-----BEGIN..."}. */
function retiredPublicKeysFromEnv(
  env: NodeJS.ProcessEnv,
): TicketPublicKeySetting[] {
  const raw = env.TICKET_RETIRED_PUBLIC_KEYS?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TICKET_RETIRED_PUBLIC_KEYS must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TICKET_RETIRED_PUBLIC_KEYS must be a JSON object');
  }

  return Object.entries(parsed).map(([kid, pem]) => {
    if (kid.trim() === '' || typeof pem !== 'string' || pem.trim() === '') {
      throw new Error(
        'TICKET_RETIRED_PUBLIC_KEYS maps each key id to a public key PEM',
      );
    }
    return { kid, publicKeyPem: pem.replace(/\\n/g, '\n') };
  });
}
