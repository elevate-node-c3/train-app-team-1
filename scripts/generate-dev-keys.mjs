#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, existsSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outputDir = join(process.cwd(), 'config', 'jwt');
const privatePath = join(outputDir, 'dev-private.pem');
const publicPath = join(outputDir, 'dev-public.pem');
const force = process.argv.includes('--force');

const isDirectory = (path) => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// Docker automatically creates empty directories on the host if the mounted
// files do not exist before `docker compose up`. Clean them up so they don't block
// key generation.
if (isDirectory(privatePath)) {
  rmSync(privatePath, { recursive: true, force: true });
}
if (isDirectory(publicPath)) {
  rmSync(publicPath, { recursive: true, force: true });
}

if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
  console.error(
    `Refusing to overwrite existing development keys in ${outputDir}.`,
  );
  console.error('Re-run with --force to replace the pair.');
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(dirname(privatePath), { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });

console.log(`Generated development JWT keys in ${outputDir}`);
console.log('Keep dev-private.pem out of git; config/jwt/ is ignored.');
