import { describe, expect, it, vi } from 'vitest';
import type { ConsumeMessage } from 'amqplib';
import {
  CLAIM_PROCESSED_EVENT_SQL,
  DEAD_LETTER_EXCHANGE,
  EVENT_SUBSCRIPTIONS,
  EventConsumerService,
  InvalidEventPayloadError,
  RETRY_EXCHANGE,
  type EventSubscription,
} from '@app/messaging';
import type { EventEnvelope } from '@app/contracts';

const QUEUE = 'notification.verification-code-issued';
const EVENT_TYPE = 'identity.verification-code.issued';

const ENVELOPE: EventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: EVENT_TYPE,
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

function message(overrides: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(ENVELOPE)),
    fields: { redelivered: false },
    properties: {
      headers: {
        'x-correlation-id': 'corr-1',
        traceparent: '00-abc-def-01',
      },
      persistent: true,
      contentType: 'application/json',
    },
    ...overrides,
  } as unknown as ConsumeMessage;
}

function subscription(handler: EventSubscription['handler']): EventSubscription {
  return {
    eventType: EVENT_TYPE,
    version: 1,
    queueName: QUEUE,
    handler,
    retryDelaysMs: [1000, 3000, 9000],
  };
}

type PublishCall = {
  exchange: string;
  routingKey: string;
  options: any;
};

function harness(
  options: {
    attempt?: number | null;
    handler?: EventSubscription['handler'];
    publishError?: Error | null;
  } = {},
) {
  const calls: string[] = [];
  const publishes: PublishCall[] = [];
  const ack = vi.fn(() => calls.push('ack'));
  const nack = vi.fn(() => calls.push('nack'));

  const plainChannel = {
    ack,
    nack,
    prefetch: vi.fn(),
    cancel: vi.fn(),
    consume: vi.fn(),
    assertExchange: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
  };
  const confirmChannel = {
    publish: vi.fn(
      (exchange: string, routingKey: string, _body: Buffer, opts: any, cb: any) => {
        publishes.push({ exchange, routingKey, options: opts });
        calls.push(`publish:${exchange}`);
        cb(options.publishError ?? null);
        return true;
      },
    ),
  };

  // The consumer reads the error from the options object via closure; this is
  // simpler than rebuilding the fake per test.
  const publishError = options.publishError ?? null;
  plainChannel.consume.mockResolvedValue({ consumerTag: 'tag-1' });
  confirmChannel.publish.mockImplementation(
    (exchange: string, routingKey: string, _body: Buffer, opts: any, cb: any) => {
      publishes.push({ exchange, routingKey, options: opts });
      calls.push(`publish:${exchange}`);
      cb(publishError);
      return true;
    },
  );

  const amqp = {
    ensureChannel: async () => plainChannel,
    ensureConfirmChannel: async () => confirmChannel,
  } as any;

  const markHandled = vi.fn(async () => {
    calls.push('markHandled');
  });
  const markSkipped = vi.fn(async () => {
    calls.push('markSkipped');
  });
  const markFailed = vi.fn(async () => {
    calls.push('markFailed');
  });
  const claim = vi.fn(async () => {
    calls.push('claim');
    return options.attempt === undefined ? 1 : options.attempt;
  });
  const store = { claim, markHandled, markSkipped, markFailed } as any;

  const handler =
    options.handler ??
    ({
      handle: async () => {
        calls.push('handle');
        return { status: 'handled' as const };
      },
    } as EventSubscription['handler']);

  const cls = {
    run: async (fn: () => Promise<unknown>) => fn(),
    set: vi.fn(),
  } as any;

  const consumer = new EventConsumerService(
    [subscription(handler)],
    amqp,
    store,
    cls,
  );

  return {
    consumer,
    sub: subscription(handler),
    calls,
    publishes,
    ack,
    nack,
    claim,
    markHandled,
    markSkipped,
    markFailed,
  };
}

describe('Event consumer (ADR-0003, ADR-0004, BR-54)', () => {
  it('acks without calling the handler when the claim is refused', async () => {
    const handler = { handle: vi.fn() } as any;
    const h = harness({ attempt: null, handler });

    await h.consumer.handleMessage(h.sub, message());

    expect(handler.handle).not.toHaveBeenCalled();
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.publishes).toEqual([]);
  });

  it('dead-letters a permanent failure immediately, with its reason and no retry', async () => {
    const h = harness({
      handler: {
        handle: async () => {
          throw new InvalidEventPayloadError('email is missing');
        },
      },
    });

    await h.consumer.handleMessage(h.sub, message());

    expect(h.publishes).toHaveLength(1);
    expect(h.publishes[0].exchange).toBe(DEAD_LETTER_EXCHANGE);
    expect(h.publishes[0].routingKey).toBe(QUEUE);
    expect(h.publishes[0].options.headers['x-death-reason']).toBe(
      'invalid-payload',
    );
    expect(h.ack).toHaveBeenCalledTimes(1);
    expect(h.nack).not.toHaveBeenCalled();
    expect(
      h.publishes.some((p) => p.exchange === RETRY_EXCHANGE),
    ).toBe(false);
  });

  it('releases the claim before republishing a transient failure, then acks', async () => {
    const h = harness({
      handler: {
        handle: async () => {
          throw new Error('smtp refused');
        },
      },
    });

    await h.consumer.handleMessage(h.sub, message());

    expect(h.calls).toEqual([
      'claim',
      'markFailed',
      `publish:${RETRY_EXCHANGE}`,
      'ack',
    ]);
    expect(h.publishes[0].routingKey).toBe(`${QUEUE}.retry.1000`);
    expect(h.publishes[0].options.headers['x-attempt']).toBe('1');
    expect(h.nack).not.toHaveBeenCalled();
  });

  it('keeps inbound headers and never copies the code or payload into headers', async () => {
    const h = harness({
      handler: {
        handle: async () => {
          throw new Error('smtp refused');
        },
      },
    });

    await h.consumer.handleMessage(h.sub, message());

    const headers = h.publishes[0].options.headers;
    // Superset of inbound — Sprint 5's replay depends on it.
    expect(headers.traceparent).toBe('00-abc-def-01');
    expect(headers['x-correlation-id']).toBe('corr-1');
    expect(headers['x-attempt']).toBe('1');
    // Neither the code nor the payload may leak into headers.
    expect(JSON.stringify(headers)).not.toContain('483920');
    expect(JSON.stringify(headers)).not.toContain('user@example.com');
  });

  it('nacks with requeue and never acks when the retry republish fails', async () => {
    const h = harness({
      publishError: new Error('broker nacked'),
      handler: {
        handle: async () => {
          throw new Error('smtp refused');
        },
      },
    });
    const msg = message();

    await h.consumer.handleMessage(h.sub, msg);

    expect(h.markFailed).toHaveBeenCalledTimes(1);
    expect(h.nack).toHaveBeenCalledWith(msg, false, true);
    expect(h.ack).not.toHaveBeenCalled();
  });

  it('dead-letters with retries-exhausted once the delays are used up', async () => {
    const h = harness({
      attempt: 4,
      handler: {
        handle: async () => {
          throw new Error('smtp refused');
        },
      },
    });

    await h.consumer.handleMessage(h.sub, message());

    expect(h.publishes[0].exchange).toBe(DEAD_LETTER_EXCHANGE);
    expect(h.publishes[0].options.headers['x-death-reason']).toBe(
      'retries-exhausted',
    );
    expect(h.ack).toHaveBeenCalledTimes(1);
  });

  it('marks skipped results without sending', async () => {
    const h = harness({
      handler: {
        handle: async () => ({
          status: 'skipped' as const,
          skipReason: 'code_expired',
        }),
      },
    });

    await h.consumer.handleMessage(h.sub, message());

    expect(h.markSkipped).toHaveBeenCalledWith(ENVELOPE.id, 'code_expired');
    expect(h.markHandled).not.toHaveBeenCalled();
    expect(h.ack).toHaveBeenCalledTimes(1);
  });

  // The whole correctness argument for two instances rests on one statement.
  it('claims with a single ON CONFLICT ... WHERE ... RETURNING statement', () => {
    expect(CLAIM_PROCESSED_EVENT_SQL).toMatch(
      /^\s*INSERT[\s\S]*ON CONFLICT[\s\S]*WHERE[\s\S]*RETURNING/is,
    );
    expect(CLAIM_PROCESSED_EVENT_SQL).not.toMatch(/^\s*SELECT/is);
    expect(CLAIM_PROCESSED_EVENT_SQL).toContain('$3::boolean');
    expect(CLAIM_PROCESSED_EVENT_SQL).toContain('RETURNING attempt_count');
  });

  it('exports the subscription token so the module can provide a pure array', () => {
    expect(typeof EVENT_SUBSCRIPTIONS).toBe('symbol');
  });
});
