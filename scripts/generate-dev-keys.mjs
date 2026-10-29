#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outputDir = join(process.cwd(), 'config', 'jwt');
const privatePath = join(outputDir, 'dev-private.pem');
const publicPath = join(outputDir, 'dev-public.pem');
const force = process.argv.includes('--force');

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
