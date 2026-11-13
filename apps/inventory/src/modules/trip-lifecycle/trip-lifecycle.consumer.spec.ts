import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import {
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_PUBLISHED_VERSION,
  TRIP_WITHDRAWN_EVENT_TYPE,
  TRIP_WITHDRAWN_VERSION,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import {
  sixStopPayload,
  withTwoCoachesNumbered,
} from '../seats/seat-plan.fixture.js';
import type { ApplyOutcome } from '../seats/seat-plan.repository.js';
import { TripLifecycleConsumer } from './trip-lifecycle.consumer.js';

const tanta = '20000000-0000-0000-0000-000000000003';
const firstClass = '50000000-0000-0000-0000-000000000002';
const tripId = sixStopPayload().tripId;

function envelopeFor<T>(
  type: string,
  version: number,
  payload: T,
): EventEnvelope<string, T> {
  return {
    id: randomUUID(),
    type,
    version,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-1',
    producer: 'catalog',
    payload,
  };
}

describe('TripLifecycleConsumer', () => {
  // Opaque in production; a plain marker is all the mock needs to compare identity.
  const ctx = { driver: 'typeorm' } as TransactionContext;

  let repository: { apply: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let outbox: { append: ReturnType<typeof vi.fn> };
  let unitOfWork: { withTransaction: ReturnType<typeof vi.fn> };
  let consumer: TripLifecycleConsumer;

  beforeEach(() => {
    repository = {
      apply: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    outbox = { append: vi.fn().mockResolvedValue(undefined) };
    unitOfWork = {
      withTransaction: vi.fn(
        (work: (ctx: TransactionContext) => Promise<unknown>) => work(ctx),
      ),
    };
    consumer = new TripLifecycleConsumer(
      repository as never,
      unitOfWork as never,
      outbox as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const publishedEnvelope = envelopeFor(
    TRIP_PUBLISHED_EVENT_TYPE,
    TRIP_PUBLISHED_VERSION,
    sixStopPayload(),
  );
  const withdrawnEnvelope = envelopeFor(
    TRIP_WITHDRAWN_EVENT_TYPE,
    TRIP_WITHDRAWN_VERSION,
    { tripId },
  );

  it('applies the plan and publishes seats-created', async () => {
    repository.apply.mockResolvedValue({
      kind: 'created',
      seatCount: 20,
      seatCountByClass: { [firstClass]: 20 },
    } satisfies ApplyOutcome);

    await expect(consumer.handle(publishedEnvelope, 1)).resolves.toEqual({
      status: 'handled',
    });
    expect(outbox.append).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ type: 'inventory.trip.seats-created' }),
    );
  });

  it('skips a stale version with the reason recorded', async () => {
    repository.apply.mockResolvedValue({
      kind: 'skipped',
      reason: 'stale-version',
    } satisfies ApplyOutcome);

    await expect(consumer.handle(publishedEnvelope, 1)).resolves.toEqual({
      status: 'skipped',
      skipReason: 'stale-version',
    });
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('throws a plain error for an incomplete payload, so the platform retries', async () => {
    // Not PermanentEventError: catalog may be mid-generation (spec §6.4).
    const envelopeWithNoCoaches = envelopeFor(
      TRIP_PUBLISHED_EVENT_TYPE,
      TRIP_PUBLISHED_VERSION,
      { ...sixStopPayload(), coaches: [] },
    );

    const thrown = await consumer
      .handle(envelopeWithNoCoaches, 1)
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PermanentEventError);
    expect(repository.apply).not.toHaveBeenCalled();
  });

  it('throws PermanentEventError for a malformed payload', async () => {
    const envelopeWithDuplicateCoachNumber = envelopeFor(
      TRIP_PUBLISHED_EVENT_TYPE,
      TRIP_PUBLISHED_VERSION,
      withTwoCoachesNumbered(1),
    );

    await expect(
      consumer.handle(envelopeWithDuplicateCoachNumber, 1),
    ).rejects.toBeInstanceOf(PermanentEventError);
    expect(repository.apply).not.toHaveBeenCalled();
    // A malformed payload must never produce any outbox event, not just skip the expected one.
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('publishes the refusal before dead-lettering, and in that order', async () => {
    // The two are not atomic (spec §6.5); the event must survive a crash more than the retry does.
    repository.apply.mockResolvedValue({
      kind: 'refused',
      occupiedSeatNumbers: ['44'],
      occupiedStationIds: [tanta],
    } satisfies ApplyOutcome);

    await expect(consumer.handle(publishedEnvelope, 1)).rejects.toBeInstanceOf(
      PermanentEventError,
    );
    // If this failed, the refusal event would have been lost with the delivery.
    expect(outbox.append).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ type: 'inventory.trip.publication-refused' }),
    );
    // Exactly one append: nothing was appended in the rolled-back first transaction.
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('warns about a capacity mismatch without refusing', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    repository.apply.mockResolvedValue({
      kind: 'created',
      seatCount: 20,
      seatCountByClass: {},
    } satisfies ApplyOutcome);
    const envelopeWithWrongCapacity = envelopeFor(
      TRIP_PUBLISHED_EVENT_TYPE,
      TRIP_PUBLISHED_VERSION,
      { ...sixStopPayload(), capacity: 999 },
    );

    const result = await consumer.handle(envelopeWithWrongCapacity, 1);

    expect(result.status).toBe('handled');
    // The warning is the only signal that catalog's summary disagreed with the layout.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(tripId);
    expect(warnings[0]).toContain('999');
  });

  it('closes a withdrawn trip and touches no occupation', async () => {
    await expect(consumer.handle(withdrawnEnvelope, 1)).resolves.toEqual({
      status: 'handled',
    });
    // Task 6's close(ctx, tripId) takes the transaction context first.
    expect(repository.close).toHaveBeenCalledWith(ctx, tripId);
  });
});
