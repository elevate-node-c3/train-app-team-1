import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationCodeIssuedEvent } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import {
  SignUpUseCase,
  type SignUpCommand,
} from './sign-up.use-case.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  VERIFICATION_CODE_REPOSITORY,
  type VerificationCodeRepositoryPort,
} from '../ports/verification-code.repository.port.js';
import type { Account } from '../../domain/account.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import { verifyVerificationCode } from '../../domain/verification-code.hashing.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Harness {
  useCase: SignUpUseCase;
  calls: string[];
  transaction: TransactionContext;
  savedAccount(): Account | undefined;
  savedCode(): VerificationCode | undefined;
  appended(): VerificationCodeIssuedEvent | undefined;
  accounts: AccountRepositoryPort;
  codes: VerificationCodeRepositoryPort;
  outbox: OutboxPort;
  unitOfWork: UnitOfWorkPort;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let account: Account | undefined;
  let code: VerificationCode | undefined;
  let event: VerificationCodeIssuedEvent | undefined;

  const accounts: AccountRepositoryPort = {
    save: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('account');
      account = value;
    },
  };
  const codes: VerificationCodeRepositoryPort = {
    save: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('code');
      code = value;
    },
  };
  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('outbox');
      event = value as VerificationCodeIssuedEvent;
    },
  };
  const unitOfWork: UnitOfWorkPort = {
    withTransaction: async <T>(
      work: (ctx: TransactionContext) => Promise<T>,
    ): Promise<T> => {
      calls.push('begin');
      const result = await work(transaction);
      calls.push('commit');
      return result;
    },
  };

  return {
    useCase: new SignUpUseCase(unitOfWork, accounts, codes, outbox),
    calls,
    transaction,
    savedAccount: () => account,
    savedCode: () => code,
    appended: () => event,
    accounts,
    codes,
    outbox,
    unitOfWork,
  };
}

function command(overrides: Partial<SignUpCommand> = {}): SignUpCommand {
  return {
    email: '  User@Example.COM ',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('SignUpUseCase (ADR-0001, BR-03, BR-56)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('injects exactly the transaction, the two repositories and the outbox', () => {
    type Dependency = { index: number; param: unknown };
    const dependencies = ((Reflect.getMetadata(
      'self:paramtypes',
      SignUpUseCase,
    ) ?? []) as Dependency[]).sort((left, right) => left.index - right.index);

    expect(dependencies.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(dependencies.map((entry) => entry.param)).toEqual([
      UNIT_OF_WORK,
      ACCOUNT_REPOSITORY,
      VERIFICATION_CODE_REPOSITORY,
      OUTBOX,
    ]);
    // No publisher, no AMQP client, no email title. If it is not a parameter,
    // it cannot be called in the wrong place.
    expect(SignUpUseCase.length).toBe(4);
  });

  it('writes account, code and outbox row on one transaction context', async () => {
    const h = harness();

    const result = await h.useCase.execute(command());

    expect(h.calls).toEqual(['begin', 'account', 'code', 'outbox', 'commit']);
    expect(result.accountId).toMatch(UUID);
    expect(result.email).toBe('user@example.com');
    expect(result.language).toBe('ar');
    expect(Object.keys(result).sort()).toEqual([
      'accountId',
      'email',
      'language',
    ]);

    const account = h.savedAccount();
    expect(account?.id).toBe(result.accountId);
    expect(account?.email).toBe('user@example.com');
    expect(account?.language).toBe('ar');
    expect(account?.status).toBe('pending');
    expect(account?.createdAt).toEqual(NOW);

    const code = h.savedCode();
    expect(code?.accountId).toBe(result.accountId);
    expect(code?.purpose).toBe('sign_up');
    expect(code?.issuedAt).toEqual(NOW);
    expect(code?.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));
  });

  it('puts the plaintext in the event and only a hash in the code row', async () => {
    const h = harness();

    const result = await h.useCase.execute(command());

    const code = h.savedCode()!;
    const event = h.appended()!;
    expect(event.payload.code).toMatch(/^\d{6}$/);
    expect(code.codeHash).not.toBe(event.payload.code);
    expect(code.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyVerificationCode(event.payload.code, code.codeSalt, code.codeHash)).toBe(
      true,
    );
    // Neither the aggregate nor the response exposes the plaintext.
    expect(JSON.stringify(code)).not.toContain(event.payload.code);
    expect('code' in result).toBe(false);
  });

  it('builds an envelope whose clock starts at issuance', async () => {
    const h = harness();
    const result = await h.useCase.execute(command());

    const event = h.appended()!;
    expect(event.id).toMatch(UUID);
    expect(event.type).toBe('identity.verification-code.issued');
    expect(event.version).toBe(1);
    expect(event.producer).toBe('identity');
    expect(event.correlationId).toBe('corr-1');
    expect(event.occurredAt).toBe(NOW.toISOString());
    expect(event.payload).toEqual({
      accountId: result.accountId,
      email: 'user@example.com',
      code: expect.stringMatching(/^\d{6}$/),
      purpose: 'sign_up',
      language: 'ar',
      issuedAt: NOW.toISOString(),
      expiresAt: '2026-10-24T10:10:00.000Z',
    });
    expect(event.payload.issuedAt).toBe(event.occurredAt);
  });

  it('honours the configured TTL inside the ten-minute cap', async () => {
    vi.stubEnv('VERIFICATION_CODE_TTL_SECONDS', '60');
    const h = harness();

    await h.useCase.execute(command());

    const event = h.appended()!;
    expect(event.payload.expiresAt).toBe('2026-10-24T10:01:00.000Z');
    expect(h.savedCode()!.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('keeps English and falls back to Arabic for anything else (BR-56)', async () => {
    const english = harness();
    await english.useCase.execute(command({ language: 'en' }));
    expect(english.savedAccount()?.language).toBe('en');
    expect(english.appended()?.payload.language).toBe('en');

    const unsupported = harness();
    await unsupported.useCase.execute(command({ language: 'fr' }));
    expect(unsupported.savedAccount()?.language).toBe('ar');
    expect(unsupported.appended()?.payload.language).toBe('ar');
  });

  it('does not open a transaction for an invalid address', async () => {
    const h = harness();

    await expect(
      h.useCase.execute(command({ email: 'not-an-address' })),
    ).rejects.toThrow(/valid email/i);
    expect(h.calls).toEqual([]);
  });

  it('appends no event when a business write rolls back', async () => {
    const h = harness();
    h.accounts.save = async () => {
      h.calls.push('account');
      throw new Error('unique violation');
    };

    await expect(h.useCase.execute(command())).rejects.toThrow(
      'unique violation',
    );
    expect(h.calls).toEqual(['begin', 'account']);
  });
});
