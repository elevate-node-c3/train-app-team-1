import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { CompactSign, compactVerify, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';
import type { TicketQrClaims } from '@app/contracts';

import { signerWithNewKey } from '../testing/ticket-fixtures.js';
import { TicketSignerService } from './ticket-signer.service.js';

const CLAIMS: TicketQrClaims = {
  ticketNumber: 'TKT-42',
  trainNumber: 916,
  boardingDate: '2099-01-10',
  boardingStation: { en: 'El Raml Station', ar: 'محطة الرمل' },
  alightingStation: { en: 'Ramsis Station', ar: 'محطة رمسيس' },
  coachNumber: 3,
  seatNumber: '12',
  passengerName: 'Omar Khaled Hassan',
  nationalIdLast4: '1234',
};

function payloadOf(qr: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(qr.split('.')[1], 'base64url').toString());
}

/** What someone with a QR image and a text editor can do. */
function withSeat(qr: string, seatNumber: string): string {
  const [header, , signature] = qr.split('.');
  const altered = Buffer.from(
    JSON.stringify({ ...payloadOf(qr), seatNumber }),
  ).toString('base64url');
  return `${header}.${altered}.${signature}`;
}

describe('TicketSignerService: the signed QR (BR-38, D11)', () => {
  it('verifies offline with nothing but the published public key', async () => {
    const { signer } = signerWithNewKey('ticket-2099-1');
    const qr = await signer.signQr(CLAIMS);

    // A scanner holds only the JWKS it downloaded: no booking, no database.
    const [jwk] = await signer.verificationKeySet();
    expect(jwk).toMatchObject({
      kid: 'ticket-2099-1',
      kty: 'OKP',
      crv: 'Ed25519',
    });
    expect(jwk).not.toHaveProperty('d');
    const { payload, protectedHeader } = await compactVerify(
      qr,
      await importJWK({ ...jwk }, 'EdDSA'),
    );

    expect(protectedHeader).toMatchObject({
      alg: 'EdDSA',
      kid: 'ticket-2099-1',
      typ: 'ticket-qr',
    });
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(CLAIMS);
  });

  it('rejects a QR whose seat was changed and re-encoded', async () => {
    const { signer } = signerWithNewKey();
    const qr = await signer.signQr(CLAIMS);

    await expect(signer.verifyQr(withSeat(qr, '13'))).resolves.toEqual({
      status: 'invalid-signature',
    });
  });

  it.each([
    ['coachNumber', 4],
    ['trainNumber', 917],
    ['passengerName', 'Someone Else'],
    ['boardingDate', '2099-01-11'],
    ['nationalIdLast4', '0000'],
    ['ticketNumber', 'TKT-43'],
  ])('rejects a QR whose %s was changed', async (field, value) => {
    const { signer } = signerWithNewKey();
    const [header, , signature] = (await signer.signQr(CLAIMS)).split('.');
    const altered = Buffer.from(
      JSON.stringify({ ...CLAIMS, [field]: value }),
    ).toString('base64url');

    expect(
      (await signer.verifyQr(`${header}.${altered}.${signature}`)).status,
    ).toBe('invalid-signature');
  });

  it('refuses even an edit a lenient base64 decoder would not notice', async () => {
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const { signer } = signerWithNewKey();
    const qr = await signer.signQr(CLAIMS);
    const token = await signer.signShareToken(
      'ticket-1',
      new Date(Date.now() + 3_600_000),
    );
    // The last character of a 64-byte signature carries 2 bits; flipping its
    // lowest bit changes only the padding a decoder throws away.
    const paddingOnly = (compact: string) =>
      compact.slice(0, -1) + alphabet[alphabet.indexOf(compact.at(-1)!) ^ 1];

    expect(Buffer.from(paddingOnly(qr).split('.')[2], 'base64url')).toEqual(
      Buffer.from(qr.split('.')[2], 'base64url'),
    );
    expect((await signer.verifyQr(paddingOnly(qr))).status).toBe('malformed');
    await expect(
      signer.verifyShareToken(paddingOnly(token)),
    ).resolves.toBeNull();
  });

  it('cannot be forged with the public key a conductor holds', async () => {
    const { signer, publicKeyPem } = signerWithNewKey();
    const publicKey = createPublicKey(publicKeyPem);

    await expect(
      new CompactSign(new TextEncoder().encode(JSON.stringify(CLAIMS)))
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: signer.keyId,
          typ: 'ticket-qr',
        })
        .sign(publicKey),
    ).rejects.toThrow();
  });

  it('rejects a QR signed by a key booking does not hold', async () => {
    const { signer } = signerWithNewKey('ticket-2099-1');
    const { signer: impostor } = signerWithNewKey('ticket-2099-1');

    expect((await signer.verifyQr(await impostor.signQr(CLAIMS))).status).toBe(
      'invalid-signature',
    );
  });

  it('never carries more of the National ID than its last four digits', async () => {
    const { signer } = signerWithNewKey();
    const qr = await signer.signQr(CLAIMS);
    const decoded = Buffer.from(qr.split('.')[1], 'base64url').toString();

    expect(payloadOf(qr).nationalIdLast4).toBe('1234');
    expect(decoded).not.toMatch(/\d{5,}/);
  });

  it.each(['', 'not-a-jws', 'a.b', '{"seat":"12"}'])(
    'answers %j as malformed',
    async (qr) => {
      const { signer } = signerWithNewKey();
      expect((await signer.verifyQr(qr)).status).toBe('malformed');
    },
  );
});

describe('TicketSignerService: key rotation', () => {
  it('keeps old tickets valid while their retired key is kept', async () => {
    const before = signerWithNewKey('ticket-2099-1');
    const oldQr = await before.signer.signQr(CLAIMS);

    const after = signerWithNewKey('ticket-2099-2', [
      { kid: 'ticket-2099-1', publicKeyPem: before.publicKeyPem },
    ]);
    const newQr = await after.signer.signQr(CLAIMS);

    expect(after.signer.keyIdOf(newQr)).toBe('ticket-2099-2');
    await expect(after.signer.verifyQr(oldQr)).resolves.toMatchObject({
      status: 'valid',
      keyId: 'ticket-2099-1',
    });
    await expect(after.signer.verifyQr(newQr)).resolves.toMatchObject({
      status: 'valid',
      keyId: 'ticket-2099-2',
    });
    expect(
      (await after.signer.verificationKeySet()).map((key) => key.kid).sort(),
    ).toEqual(['ticket-2099-1', 'ticket-2099-2']);
  });

  it('stops accepting a key once it is no longer retained', async () => {
    const before = signerWithNewKey('ticket-2099-1');
    const oldQr = await before.signer.signQr(CLAIMS);
    const after = signerWithNewKey('ticket-2099-2');

    expect((await after.signer.verifyQr(oldQr)).status).toBe(
      'invalid-signature',
    );
  });

  it('refuses a signing key that is not Ed25519', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      new TicketSignerService().load({
        keyId: 'rsa',
        privateKeyPem: privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        retiredPublicKeys: [],
      }),
    ).toThrow('Ed25519');
  });
});

describe('TicketSignerService: share tokens (BR-39)', () => {
  const inAnHour = (): Date => new Date(Date.now() + 3_600_000);

  it('names one ticket until it expires', async () => {
    const { signer } = signerWithNewKey();
    const token = await signer.signShareToken('ticket-1', inAnHour());

    await expect(signer.verifyShareToken(token)).resolves.toBe('ticket-1');
    // The link carries the ticket and its expiry, and nothing personal.
    expect(Object.keys(payloadOf(token)).sort()).toEqual(['exp', 'sub']);
  });

  it('stops working once expired', async () => {
    const { signer } = signerWithNewKey();
    const token = await signer.signShareToken(
      'ticket-1',
      new Date(Date.now() - 60_000),
    );

    await expect(signer.verifyShareToken(token)).resolves.toBeNull();
  });

  it('rejects a token pointed at another ticket', async () => {
    const { signer } = signerWithNewKey();
    const [header, , signature] = (
      await signer.signShareToken('ticket-1', inAnHour())
    ).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'ticket-2', exp: 4_102_444_800 }),
    ).toString('base64url');

    await expect(
      signer.verifyShareToken(`${header}.${forged}.${signature}`),
    ).resolves.toBeNull();
  });

  it('never lets a QR pass for a share token, or the reverse', async () => {
    const { signer } = signerWithNewKey();
    const qr = await signer.signQr(CLAIMS);
    const token = await signer.signShareToken('ticket-1', inAnHour());

    await expect(signer.verifyShareToken(qr)).resolves.toBeNull();
    expect((await signer.verifyQr(token)).status).toBe('malformed');
  });
});
