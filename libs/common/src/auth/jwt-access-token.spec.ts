import { generateKeyPairSync } from 'node:crypto';
import { importPKCS8, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_CLAIM_KEYS,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  TOKEN_DEFAULTS,
} from '@app/contracts';
import {
  AccessTokenVerificationError,
  buildAccessTokenClaims,
} from './access-token.claims.js';
import { JwtAccessTokenSigner } from './access-token.signer.js';
import { JwtAccessTokenVerifier } from './access-token.verifier.js';

interface KeyPair {
  privatePem: string;
  publicPem: string;
}

function keyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

const ACTIVE = keyPair();
const PREVIOUS = keyPair();

const SIGN_INPUT = {
  sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  lvl: 'traveller' as const,
  roles: ['operator'],
  sid: 'session-1',
  bkbl: true,
  jti: 'jti-1',
};

async function signerFor(
  keys: KeyPair,
  kid: string,
  accessTtlSeconds = TOKEN_DEFAULTS.accessTtlSeconds,
): Promise<JwtAccessTokenSigner> {
  return JwtAccessTokenSigner.create({
    kid,
    privateKeyPem: keys.privatePem,
    accessTtlSeconds,
  });
}

async function verifier(options: {
  clockSkewSeconds?: number;
  previous?: KeyPair;
} = {}): Promise<JwtAccessTokenVerifier> {
  return JwtAccessTokenVerifier.create({
    active: { kid: 'active', publicKeyPem: ACTIVE.publicPem },
    ...(options.previous
      ? {
          previous: {
            kid: 'previous',
            publicKeyPem: options.previous.publicPem,
          },
        }
      : {}),
    clockSkewSeconds: options.clockSkewSeconds ?? 0,
  });
}

async function signRaw(
  privatePem: string,
  payload: JWTPayload,
  header: { alg?: string; typ?: string; kid?: string } = {},
): Promise<string> {
  const key = await importPKCS8(privatePem, JWT_ALGORITHM);
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: JWT_ALGORITHM,
      typ: 'JWT',
      kid: 'active',
      ...header,
    } as never)
    .sign(key);
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

async function failureOf(
  promise: Promise<unknown>,
): Promise<AccessTokenVerificationError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AccessTokenVerificationError);
    return error as AccessTokenVerificationError;
  }
  throw new Error('expected verification to fail');
}

describe('JWT access tokens (F6a, F6b, BR-10)', () => {
  it('mints and verifies the complete claim set', async () => {
    const signer = await signerFor(ACTIVE, 'active');
    const verifierInstance = await verifier();

    const signed = await signer.sign(SIGN_INPUT);
    const claims = await verifierInstance.verify(signed.token);

    expect(Object.keys(claims).sort()).toEqual(
      [...ACCESS_TOKEN_CLAIM_KEYS].sort(),
    );
    expect(claims).toMatchObject({
      ...SIGN_INPUT,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    });
    expect(claims.exp - claims.iat).toBe(TOKEN_DEFAULTS.accessTtlSeconds);
  });

  it('never places an e-mail, name or phone in the token', async () => {
    const signer = await signerFor(ACTIVE, 'active');

    const signed = await signer.sign(SIGN_INPUT);
    const payload = JSON.parse(
      Buffer.from(signed.token.split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      [...ACCESS_TOKEN_CLAIM_KEYS].sort(),
    );
    for (const key of ['email', 'name', 'phone', 'password']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('builds claims from one place with an injected clock and jti', () => {
    const now = new Date('2026-10-24T10:00:00.000Z');
    const claims = buildAccessTokenClaims(
      { ...SIGN_INPUT, now },
      {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        accessTtlSeconds: 900,
      },
    );

    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.exp).toBe(claims.iat + 900);
    expect(claims.jti).toBe('jti-1');
    expect(claims.roles).toEqual(['operator']);
    expect(claims.roles).not.toBe(SIGN_INPUT.roles);
  });

  it('generates a jti when the caller does not supply one', () => {
    const claims = buildAccessTokenClaims(
      { ...SIGN_INPUT, jti: undefined },
      {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        accessTtlSeconds: 900,
      },
    );

    expect(claims.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('reports an expired token separately from an invalid one', async () => {
    const signer = await signerFor(ACTIVE, 'active', 900);
    const verifierInstance = await verifier();
    const signed = await signer.sign({
      ...SIGN_INPUT,
      now: new Date(Date.now() - 901_000),
    });

    const error = await failureOf(verifierInstance.verify(signed.token));

    expect(error.reason).toBe('expired');
  });

  it('tolerates only the configured clock skew', async () => {
    const signer = await signerFor(ACTIVE, 'active', 900);
    const signed = await signer.sign({
      ...SIGN_INPUT,
      now: new Date(Date.now() - 910_000),
    });

    await expect(
      (await verifier({ clockSkewSeconds: 30 })).verify(signed.token),
    ).resolves.toMatchObject({ sub: SIGN_INPUT.sub });
    await expect(
      (await verifier({ clockSkewSeconds: 5 })).verify(signed.token),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('rejects an HS256 token signed with the public key (algorithm confusion)', async () => {
    const header = base64url({
      alg: 'HS256',
      typ: 'JWT',
      kid: 'active',
    });
    const payload = base64url({
      sub: SIGN_INPUT.sub,
      lvl: SIGN_INPUT.lvl,
      roles: SIGN_INPUT.roles,
      sid: SIGN_INPUT.sid,
      jti: SIGN_INPUT.jti,
      bkbl: true,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    const crypto = await import('node:crypto');
    const signature = crypto
      .createHmac('sha256', ACTIVE.publicPem)
      .update(`${header}.${payload}`)
      .digest('base64url');

    const error = await failureOf(
      (await verifier()).verify(`${header}.${payload}.${signature}`),
    );

    expect(error.reason).toBe('invalid');
  });

  it('rejects an unsigned `alg: none` token', async () => {
    const header = base64url({ alg: 'none', typ: 'JWT', kid: 'active' });
    const payload = base64url({
      sub: SIGN_INPUT.sub,
      lvl: SIGN_INPUT.lvl,
      roles: SIGN_INPUT.roles,
      sid: SIGN_INPUT.sid,
      jti: SIGN_INPUT.jti,
      bkbl: true,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const error = await failureOf(
      (await verifier()).verify(`${header}.${payload}.`),
    );

    expect(error.reason).toBe('invalid');
  });

  it('rejects an unknown kid without trying another key', async () => {
    const signer = await signerFor(ACTIVE, 'not-configured');
    const signed = await signer.sign(SIGN_INPUT);

    const error = await failureOf((await verifier()).verify(signed.token));

    expect(error.message).toMatch(/key id/i);
  });

  it('rejects a token whose header type is not JWT', async () => {
    const signed = await signRaw(
      ACTIVE.privatePem,
      {
        sub: SIGN_INPUT.sub,
        lvl: SIGN_INPUT.lvl,
        roles: SIGN_INPUT.roles,
        sid: SIGN_INPUT.sid,
        jti: SIGN_INPUT.jti,
        bkbl: true,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      { typ: 'JWTX' },
    );

    const error = await failureOf((await verifier()).verify(signed));

    expect(error.reason).toBe('invalid');
  });

  it('accepts a token signed with the previous key during rotation', async () => {
    const oldSigner = await signerFor(PREVIOUS, 'previous');
    const signed = await oldSigner.sign(SIGN_INPUT);

    await expect(
      (await verifier({ previous: PREVIOUS })).verify(signed.token),
    ).resolves.toMatchObject({ sub: SIGN_INPUT.sub });
    await expect((await verifier()).verify(signed.token)).rejects.toMatchObject(
      { reason: 'invalid' },
    );
  });

  it('rejects a tampered payload even with a valid-looking header', async () => {
    const signer = await signerFor(ACTIVE, 'active');
    const signed = await signer.sign(SIGN_INPUT);
    const [header, payload, signature] = signed.token.split('.');
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    claims.lvl = 'bookable';
    const tampered = `${header}.${base64url(claims)}.${signature}`;

    const error = await failureOf((await verifier()).verify(tampered));

    expect(error.reason).toBe('invalid');
  });

  it('rejects a token with a missing authorization claim', async () => {
    const payload = {
      sub: SIGN_INPUT.sub,
      lvl: SIGN_INPUT.lvl,
      roles: SIGN_INPUT.roles,
      sid: SIGN_INPUT.sid,
      // no jti
      bkbl: true,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const signed = await signRaw(ACTIVE.privatePem, payload);

    const error = await failureOf((await verifier()).verify(signed));

    expect(error.reason).toBe('invalid');
  });

  it('rejects a bookable claim that is not a boolean', async () => {
    const payload = {
      sub: SIGN_INPUT.sub,
      lvl: SIGN_INPUT.lvl,
      roles: SIGN_INPUT.roles,
      sid: SIGN_INPUT.sid,
      jti: SIGN_INPUT.jti,
      bkbl: 'true',
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const signed = await signRaw(ACTIVE.privatePem, payload);

    const error = await failureOf((await verifier()).verify(signed));

    expect(error.reason).toBe('invalid');
  });

  it('rejects a token for another audience or issuer', async () => {
    const signer = await JwtAccessTokenSigner.create({
      kid: 'active',
      privateKeyPem: ACTIVE.privatePem,
      issuer: 'somebody-else',
      audience: 'another-service',
    });
    const signed = await signer.sign(SIGN_INPUT);

    const error = await failureOf((await verifier()).verify(signed.token));

    expect(error.reason).toBe('invalid');
  });
});
