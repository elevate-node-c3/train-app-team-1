import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_PROCESSED_EVENT_SQL,
  MARK_PROCESSED_EVENT_FAILED_SQL,
  MARK_PROCESSED_EVENT_HANDLED_SQL,
  MARK_PROCESSED_EVENT_SKIPPED_SQL,
  TypeOrmProcessedEventStore,
} from '@app/messaging';

function storeWith(query: (sql: string, params?: unknown[]) => unknown) {
  const dataSource = { query: vi.fn(query) };
  const initializer = {
    ensureInitialized: async () => dataSource,
  };
  return {
    store: new TypeOrmProcessedEventStore(initializer as any),
    dataSource,
  };
}

describe('Processed-event claim store (BR-54, ADR-0003)', () => {
  it('returns the attempt number when the claim wins', async () => {
    const { store, dataSource } = storeWith(async () => [
      { attempt_count: '2' },
    ]);

    await expect(
      store.claim({
        eventId: 'evt-1',
        eventType: 'identity.verification-code.issued',
        redelivered: true,
        leaseSeconds: 60,
      }),
    ).resolves.toBe(2);

    expect(dataSource.query).toHaveBeenCalledWith(CLAIM_PROCESSED_EVENT_SQL, [
      'evt-1',
      'identity.verification-code.issued',
      true,
      60,
    ]);
  });

  it('returns null when the conflict predicate matches no row', async () => {
    const { store } = storeWith(async () => []);
    await expect(
      store.claim({
        eventId: 'evt-1',
        eventType: 'identity.verification-code.issued',
        redelivered: false,
        leaseSeconds: 60,
      }),
    ).resolves.toBeNull();
  });

  it('marks handled, skipped and failed with their own statements', async () => {
    const { store, dataSource } = storeWith(async () => []);

    await store.markHandled('evt-1');
    await store.markSkipped('evt-1', 'code_expired');
    await store.markFailed('evt-1', 'smtp refused');

    expect(dataSource.query).toHaveBeenNthCalledWith(
      1,
      MARK_PROCESSED_EVENT_HANDLED_SQL,
      ['evt-1'],
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      2,
      MARK_PROCESSED_EVENT_SKIPPED_SQL,
      ['evt-1', 'code_expired'],
    );
    expect(dataSource.query).toHaveBeenNthCalledWith(
      3,
      MARK_PROCESSED_EVENT_FAILED_SQL,
      ['evt-1', 'smtp refused'],
    );
  });

  it('only releases a claim that is still processing', () => {
    expect(MARK_PROCESSED_EVENT_FAILED_SQL).toContain("status = 'failed'");
    expect(MARK_PROCESSED_EVENT_FAILED_SQL).toContain(
      "AND status = 'processing'",
    );
  });
});
