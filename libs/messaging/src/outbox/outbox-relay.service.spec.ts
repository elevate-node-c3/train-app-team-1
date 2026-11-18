import { afterEach, describe, expect, it, vi } from 'vitest';
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
  _retryDelayMs: number,
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

afterEach(() => vi.unstubAllEnvs());

function pipelineHarness(
  count: number,
  publishConfirmed: (event: EventEnvelope) => Promise<void>,
) {
  const transaction = ctx();
  const rows = Array.from({ length: count }, (_, index) =>
    rowFrom(
      appendParams({
        ...EVENT,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      }),
    ),
  );
  const outbox = {
    claimBatch: vi.fn(async () => rows),
    markPublishedBatch: vi.fn(
      async (_ctx: TransactionContext, _ids: readonly string[]) => {},
    ),
    recordFailure: vi.fn(recordFailureStub),
  };
  const relay = new OutboxRelayService(
    {
      withTransaction: async <T>(
        work: (ctx: TransactionContext) => Promise<T>,
      ) => work(transaction),
    },
    outbox as never,
    { publishConfirmed } as never,
    fakeCls(),
    new SchemaReadinessGate(),
  );
  return { relay, outbox, transaction, ids: rows.map((row) => row.id) };
}

describe('Outbox relay (ADR-0001, ADR-0002)', () => {
  it('bounds parallel confirms and marks the entire confirmed batch once', async () => {
    vi.stubEnv('OUTBOX_PUBLISH_CONCURRENCY', '2');
    const finish: (() => void)[] = [];
    let active = 0;
    let maximum = 0;
    const publish = vi.fn(async (_event: EventEnvelope) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => finish.push(resolve));
      active -= 1;
    });
    const h = pipelineHarness(5, publish);
    const run = h.relay.runOnce();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    finish[1]();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(h.outbox.markPublishedBatch).not.toHaveBeenCalled();
    finish[0]();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(4));
    finish[2]();
    finish[3]();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(5));
    finish[4]();
    await expect(run).resolves.toBe(5);
    expect(maximum).toBe(2);
    expect(h.outbox.markPublishedBatch).toHaveBeenCalledExactlyOnceWith(
      h.transaction,
      h.ids,
    );
  });

  it('marks confirmed neighbours but retries a failed ID and stops new windows', async () => {
    vi.stubEnv('OUTBOX_PUBLISH_CONCURRENCY', '2');
    const publish = vi.fn(async (event: EventEnvelope) => {
      if (event.id.endsWith('2'))
        throw new Error('AMQP mandatory return 312 NO_ROUTE');
    });
    const h = pipelineHarness(4, publish);
    await expect(h.relay.runOnce()).resolves.toBe(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(h.outbox.markPublishedBatch).toHaveBeenCalledExactlyOnceWith(
      h.transaction,
      [h.ids[0]],
    );
    expect(h.outbox.recordFailure).toHaveBeenCalledExactlyOnceWith(
      h.transaction,
      h.ids[1],
      'AMQP mandatory return 312 NO_ROUTE',
      250,
    );
  });

  it.each(['0', '65', 'NaN', '2.5'])(
    'keeps invalid concurrency %s on the serial fallback',
    async (value) => {
      vi.stubEnv('OUTBOX_PUBLISH_CONCURRENCY', value);
      let active = 0;
      let maximum = 0;
      const h = pipelineHarness(3, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= 1;
      });
      await expect(h.relay.runOnce()).resolves.toBe(3);
      expect(maximum).toBe(1);
    },
  );

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
      markPublishedBatch: async (
        received: TransactionContext,
        ids: readonly string[],
      ) => {
        calls.push('markPublishedBatch');
        expect(received).toBe(transaction);
        expect(ids).toEqual([EVENT.id]);
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
    expect(calls).toEqual(['claim', 'publishConfirmed', 'markPublishedBatch']);
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
      markPublishedBatch: markPublished,
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

    const [receivedCtx, id, message, retryDelayMs] =
      recordFailure.mock.calls[0];
    expect(receivedCtx).toBe(transaction);
    expect(id).toBe(EVENT.id);
    expect(message).toBe('broker rejected the publish');
    expect(message).not.toContain((EVENT.payload as { code: string }).code);
    expect(retryDelayMs).toBe(relayBackoffMs(1));
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
        markPublishedBatch: vi.fn(),
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

  it('retries the same envelope ID after a rejected confirmation', async () => {
    const transaction = ctx();
    const publishConfirmed = vi
      .fn(async (_event: EventEnvelope) => {})
      .mockRejectedValueOnce(new Error('AMQP mandatory return 312 NO_ROUTE'));
    const markPublished = vi.fn(async () => {});
    const recordFailure = vi.fn(recordFailureStub);
    const relay = new OutboxRelayService(
      {
        withTransaction: async <T>(
          work: (c: TransactionContext) => Promise<T>,
        ) => work(transaction),
      },
      {
        claimBatch: async () => [rowFrom(appendParams(EVENT))],
        markPublishedBatch: markPublished,
        recordFailure,
      } as any,
      { publishConfirmed } as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );

    await expect(relay.runOnce()).resolves.toBe(0);
    expect(markPublished).not.toHaveBeenCalled();
    await expect(relay.runOnce()).resolves.toBe(1);
    expect(publishConfirmed.mock.calls.map(([event]) => event)).toEqual([
      EVENT,
      EVENT,
    ]);
    expect(recordFailure).toHaveBeenCalledWith(
      transaction,
      EVENT.id,
      'AMQP mandatory return 312 NO_ROUTE',
      250,
    );
    expect(markPublished).toHaveBeenCalledWith(transaction, [EVENT.id]);
  });

  it('propagates a post-confirmation database failure without marking a broker failure', async () => {
    const recordFailure = vi.fn(recordFailureStub);
    const publishConfirmed = vi.fn(async () => {});
    const relay = new OutboxRelayService(
      {
        withTransaction: async <T>(
          work: (c: TransactionContext) => Promise<T>,
        ) => work(ctx()),
      },
      {
        claimBatch: async () => [rowFrom(appendParams(EVENT))],
        markPublishedBatch: vi.fn(async () => {
          throw new Error('database connection lost');
        }),
        recordFailure,
      } as any,
      { publishConfirmed } as any,
      fakeCls(),
      new SchemaReadinessGate(),
    );

    await expect(relay.runOnce()).rejects.toThrow('database connection lost');
    expect(publishConfirmed).toHaveBeenCalledTimes(1);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('drains consecutive nonempty successful batches before the idle delay', async () => {
    vi.useFakeTimers();
    try {
      await withPollInterval(1_000, async () => {
        const relay = new OutboxRelayService(
          { withTransaction: vi.fn() } as any,
          {} as any,
          {} as any,
          fakeCls(),
          new SchemaReadinessGate(),
        );
        const runOnce = vi
          .spyOn(relay, 'runOnce')
          .mockResolvedValue(0)
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1);
        const wait = vi.spyOn(relay as any, 'wait');
        try {
          relay.onApplicationBootstrap();
          await vi.advanceTimersByTimeAsync(0);
          expect(runOnce).toHaveBeenCalledTimes(3);
          expect(wait).toHaveBeenCalledExactlyOnceWith(1_000);
          await vi.advanceTimersByTimeAsync(999);
          expect(runOnce).toHaveBeenCalledTimes(3);
        } finally {
          await relay.beforeApplicationShutdown();
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delays a partially successful batch that ended in a publish failure', async () => {
    vi.useFakeTimers();
    try {
      await withPollInterval(1_000, async () => {
        const claimBatch = vi.fn(async () => [
          rowFrom(appendParams(EVENT)),
          rowFrom(appendParams({ ...EVENT, id: 'second' })),
        ]);
        const publishConfirmed = vi.fn(async (event: EventEnvelope) => {
          if (event.id === 'second') throw new Error('broker disconnected');
        });
        const relay = new OutboxRelayService(
          {
            withTransaction: async <T>(
              work: (c: TransactionContext) => Promise<T>,
            ) => work(ctx()),
          },
          {
            claimBatch,
            markPublishedBatch: vi.fn(async () => {}),
            recordFailure: vi.fn(recordFailureStub),
          } as any,
          { publishConfirmed } as any,
          fakeCls(),
          new SchemaReadinessGate(),
        );
        try {
          relay.onApplicationBootstrap();
          await vi.advanceTimersByTimeAsync(0);
          expect(claimBatch).toHaveBeenCalledTimes(1);
          expect(publishConfirmed).toHaveBeenCalledTimes(2);
          await vi.advanceTimersByTimeAsync(999);
          expect(claimBatch).toHaveBeenCalledTimes(1);
        } finally {
          await relay.beforeApplicationShutdown();
        }
      });
    } finally {
      vi.useRealTimers();
    }
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
        {
          claimBatch,
          markPublishedBatch: vi.fn(),
          recordFailure: vi.fn(),
        } as any,
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
        {
          claimBatch,
          markPublishedBatch: vi.fn(),
          recordFailure: vi.fn(),
        } as any,
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
