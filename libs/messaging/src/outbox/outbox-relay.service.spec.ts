import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import {
  CLAIM_OUTBOX_SQL,
  OutboxRelayService,
  appendParams,
  envelopeOf,
  relayBackoffMs,
  rowFrom,
} from '@app/messaging';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

/** Match repository parameters so spies record the error message's argument. */
async function recordFailureStub(
  _ctx: TransactionContext,
  _id: string,
  _lastError: string,
  _nextAttemptAt: Date,
): Promise<void> {}

const EVENT: EventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'identity.verification-code.issued',
  version: 1,
  occurredAt: '2026-10-24T10:00:00.000Z',
  correlationId: 'corr-1',
  producer: 'identity',
  payload: {
    accountId: 'acc-1',
    email: 'user@example.com',
    code: '483920',
    purpose: 'sign_up',
    language: 'en',
    issuedAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-24T10:10:00.000Z',
  },
};

function ctx(): TransactionContext {
  return { driver: 'fake' };
}

function fakeCls(): any {
  return {
    run: async (fn: () => Promise<void>) => fn(),
    set: vi.fn(),
  };
}

// Wrap the test body; every tick reads its interval from the environment.
async function withPollInterval(
  ms: number,
  work: () => Promise<void>,
): Promise<void> {
  const previous = process.env.OUTBOX_POLL_INTERVAL_MS;
  process.env.OUTBOX_POLL_INTERVAL_MS = String(ms);
  try {
    await work();
  } finally {
    if (previous === undefined) delete process.env.OUTBOX_POLL_INTERVAL_MS;
    else process.env.OUTBOX_POLL_INTERVAL_MS = previous;
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Outbox relay (ADR-0001, ADR-0002)', () => {
  it('claims rows with FOR UPDATE SKIP LOCKED', () => {
    expect(CLAIM_OUTBOX_SQL).toContain('FOR UPDATE SKIP LOCKED');
    expect(CLAIM_OUTBOX_SQL).toContain('published_at IS NULL');
  });

  // Claim, publish, and mark must share the same transaction and row lock.
  it('publishes between claim and mark on the same context', async () => {
    const transaction = ctx();
    const calls: string[] = [];
    const rows = [rowFrom(appendParams(EVENT))];

    const outbox = {
      claimBatch: async (received: TransactionContext) => {
        calls.push('claim');
        expect(received).toBe(transaction);
        return rows;
      },
      markPublished: async (received: TransactionContext, id: string) => {
        calls.push('markPublished');
        expect(received).toBe(transaction);
        expect(id).toBe(EVENT.id);
      },
      recordFailure: vi.fn(),
    };
    const publisher = {
      publishConfirmed: async (envelope: EventEnvelope) => {
        calls.push('publishConfirmed');
        expect(envelope).toEqual(EVENT);
      },
    };
    const relay = new OutboxRelayService(
      {
        withTransaction: async <T>(
          work: (c: TransactionContext) => Promise<T>,
        ) => work(transaction),
      },
      outbox as any,
      publisher as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );

    await expect(relay.runOnce()).resolves.toBe(1);
    expect(calls).toEqual(['claim', 'publishConfirmed', 'markPublished']);
    expect(outbox.recordFailure).not.toHaveBeenCalled();
  });

  // Commit retry bookkeeping and stop the batch; throwing would roll back the backoff.
  it('breaks the batch without throwing when a publish is rejected', async () => {
    const transaction = ctx();
    const rows = [
      rowFrom(appendParams(EVENT)),
      rowFrom(appendParams({ ...EVENT, id: 'second' })),
    ];
    const recordFailure = vi.fn(recordFailureStub);
    const markPublished = vi.fn(async () => {});
    const outbox = {
      claimBatch: async () => rows,
      markPublished,
      recordFailure,
    };
    const publisher = {
      publishConfirmed: async () => {
        throw new Error('broker rejected the publish');
      },
    };
    const relay = new OutboxRelayService(
      {
        withTransaction: async <T>(
          work: (c: TransactionContext) => Promise<T>,
        ) => work(transaction),
      },
      outbox as any,
      publisher as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );

    await expect(relay.runOnce()).resolves.toBe(0);

    expect(markPublished).not.toHaveBeenCalled();
    expect(recordFailure).toHaveBeenCalledTimes(1);

    const [receivedCtx, id, message, nextAttemptAt] =
      recordFailure.mock.calls[0];
    expect(receivedCtx).toBe(transaction);
    expect(id).toBe(EVENT.id);
    expect(message).toBe('broker rejected the publish');
    expect(message).not.toContain((EVENT.payload as { code: string }).code);
    expect(nextAttemptAt).toBeInstanceOf(Date);
  });

  it('never stores the payload in last_error', async () => {
    const rows = [rowFrom(appendParams(EVENT))];
    const recordFailure = vi.fn(recordFailureStub);
    const relay = new OutboxRelayService(
      {
        withTransaction: async <T>(
          work: (c: TransactionContext) => Promise<T>,
        ) => work(ctx()),
      },
      {
        claimBatch: async () => rows,
        markPublished: vi.fn(),
        recordFailure,
      } as any,
      {
        publishConfirmed: async () => {
          throw new Error('smtp: connection refused');
        },
      } as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );

    await relay.runOnce();

    const stored = String(recordFailure.mock.calls[0][2]);
    expect(stored).toBe('smtp: connection refused');
    expect(stored).not.toContain((EVENT.payload as { code: string }).code);
    expect(stored).not.toContain('user@example.com');
  });

  // Wait for migrations before the first claim touches its table.
  it('does not claim rows until the schema is settled', async () => {
    const gate = new SchemaReadinessGate();
    gate.expectMigrations();

    const claimBatch = vi.fn(async () => []);

    await withPollInterval(5, async () => {
      const relay = new OutboxRelayService(
        {
          withTransaction: async <T>(
            work: (c: TransactionContext) => Promise<T>,
          ) => work(ctx()),
        },
        { claimBatch, markPublished: vi.fn(), recordFailure: vi.fn() } as any,
        { publishConfirmed: vi.fn() } as any,
        fakeCls(),
        gate,
      );

      try {
        relay.onApplicationBootstrap();
        await tick(40); // Several poll intervals.
        expect(claimBatch).not.toHaveBeenCalled();

        gate.markSettled();
        await tick(40);
        expect(claimBatch).toHaveBeenCalled();
      } finally {
        await relay.beforeApplicationShutdown();
      }
    });
  });

  // Failed migrations settle the gate; errors must not kill polling.
  it('keeps ticking after a tick throws', async () => {
    const gate = new SchemaReadinessGate();
    gate.expectMigrations();
    gate.markSettled();

    const claimBatch = vi.fn(async () => {
      throw new Error('relation "outbox_event" does not exist');
    });

    await withPollInterval(5, async () => {
      const relay = new OutboxRelayService(
        {
          withTransaction: async <T>(
            work: (c: TransactionContext) => Promise<T>,
          ) => work(ctx()),
        },
        { claimBatch, markPublished: vi.fn(), recordFailure: vi.fn() } as any,
        { publishConfirmed: vi.fn() } as any,
        fakeCls(),
        gate,
      );

      try {
        relay.onApplicationBootstrap();
        await tick(40);
        expect(claimBatch.mock.calls.length).toBeGreaterThan(1);
      } finally {
        await relay.beforeApplicationShutdown();
      }
    });
  });

  it('round-trips an envelope through the row mapping', () => {
    expect(envelopeOf(rowFrom(appendParams(EVENT)))).toEqual(EVENT);
  });

  it('backs off from 250ms to a 5s cap', () => {
    expect(relayBackoffMs(1)).toBe(250);
    expect(relayBackoffMs(2)).toBe(500);
    expect(relayBackoffMs(10)).toBe(5000);
  });

  it('does no I/O in the constructor', () => {
    const outbox = {
      claimBatch: vi.fn(() => {
        throw new Error('claimed in constructor');
      }),
    };
    const publisher = {
      publishConfirmed: vi.fn(() => {
        throw new Error('published in constructor');
      }),
    };
    new OutboxRelayService(
      {
        withTransaction: vi.fn(() => {
          throw new Error('transaction in constructor');
        }),
      },
      outbox as any,
      publisher as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );
    expect(outbox.claimBatch).not.toHaveBeenCalled();
    expect(publisher.publishConfirmed).not.toHaveBeenCalled();
  });
});
