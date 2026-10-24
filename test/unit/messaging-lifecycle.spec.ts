import { describe, expect, it } from 'vitest';
import { CORRELATION_ID_HEADER as COMMON_CORRELATION_ID_HEADER } from '@app/common';
import {
  AmqpClientService,
  CORRELATION_ID_HEADER,
  extractCorrelationId,
  injectCorrelationId,
} from '@app/messaging';
import { GracefulShutdownService } from '@app/common';

/**
 * These assertions pin Nest's shutdown contract as it actually behaves:
 * `onModuleDestroy` -> `beforeApplicationShutdown` -> dispose -> 
 * `onApplicationShutdown`. The repo's docs claimed the opposite, and following
 * them would close the channel before consumers could ack.
 */
describe('Messaging lifecycle (ADR-0003, ADR-0004)', () => {
  it('keeps one correlation header constant across both libraries', () => {
    expect(CORRELATION_ID_HEADER).toBe(COMMON_CORRELATION_ID_HEADER);
  });

  it('injects and extracts a string correlation id', () => {
    const headers = injectCorrelationId('abc', { other: 'kept' });
    expect(headers).toEqual({
      other: 'kept',
      [CORRELATION_ID_HEADER]: 'abc',
    });
    expect(extractCorrelationId(headers)).toBe('abc');
  });

  it('extracts a correlation id stored as a Buffer', () => {
    expect(
      extractCorrelationId({ [CORRELATION_ID_HEADER]: Buffer.from('abc') }),
    ).toBe('abc');
  });

  it('does not promise an onModuleDestroy hook on the AMQP client', () => {
    const client = new AmqpClientService();
    // Re-adding one would close the channel in step 1, before the relay and
    // consumer drain in step 2. This assertion is the guard against that.
    expect('onModuleDestroy' in client).toBe(false);
    expect(typeof client.onApplicationShutdown).toBe('function');
  });

  it('closes the channels only at onApplicationShutdown, after acks', async () => {
    const calls: string[] = [];
    const client = new AmqpClientService() as any;
    client.confirmChannel = {
      close: async () => {
        calls.push('confirm-close');
      },
    };
    client.channel = {
      close: async () => {
        calls.push('channel-close');
      },
    };
    client.connection = {
      close: async () => {
        calls.push('connection-close');
      },
    };

    // A drain participant's ack is recorded first; the client must not close
    // before it. This mirrors Nest's real hook order (step 2 then step 4).
    calls.push('ack');
    await client.onApplicationShutdown();

    expect(calls).toEqual([
      'ack',
      'confirm-close',
      'channel-close',
      'connection-close',
    ]);
  });

  it('stops accepting requests in onModuleDestroy, not onApplicationShutdown', () => {
    const shutdown = new GracefulShutdownService();
    expect(shutdown.isAcceptingRequests()).toBe(true);

    shutdown.onModuleDestroy();

    expect(shutdown.isAcceptingRequests()).toBe(false);
    expect('onApplicationShutdown' in shutdown).toBe(false);
  });
});
