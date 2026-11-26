#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const force = process.argv.includes('--force');

/**
 * Each development pair, and who holds its private half:
 * - JWT (RSA): identity signs access tokens, the gateway verifies them.
 * - Ticket signing (Ed25519, TA-108): booking signs ticket QRs and share
 *   links; conductors only ever get the public half.
 *
 * A pair that already exists is kept unless --force is given, so re-running
 * after a new pair is added creates only the missing one.
 */
const PAIRS = [
  {
    name: 'JWT',
    dir: join(process.cwd(), 'config', 'jwt'),
    generate: () =>
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }),
  },
  {
    name: 'ticket signing',
    dir: join(process.cwd(), 'config', 'ticket-signing'),
    generate: () =>
      generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      }),
  },
];

const isDirectory = (path) => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

for (const pair of PAIRS) {
  const privatePath = join(pair.dir, 'dev-private.pem');
  const publicPath = join(pair.dir, 'dev-public.pem');

  // Docker automatically creates empty directories on the host if the mounted
  // files do not exist before `docker compose up`. Clean them up so they don't
  // block key generation.
  if (isDirectory(privatePath)) {
    rmSync(privatePath, { recursive: true, force: true });
  }
  if (isDirectory(publicPath)) {
    rmSync(publicPath, { recursive: true, force: true });
  }

  if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
    console.log(
      `Keeping existing development ${pair.name} keys in ${pair.dir} (--force replaces them).`,
    );
    continue;
  }

  const { privateKey, publicKey } = pair.generate();
  mkdirSync(pair.dir, { recursive: true });
  writeFileSync(privatePath, privateKey, { mode: 0o600 });
  writeFileSync(publicPath, publicKey, { mode: 0o644 });
  console.log(`Generated development ${pair.name} keys in ${pair.dir}`);
}

console.log('Keep dev-private.pem files out of git; *.pem is ignored.');
