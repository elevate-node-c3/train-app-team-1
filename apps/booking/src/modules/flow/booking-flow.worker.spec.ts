import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BookingFlowWorker } from './booking-flow.worker.js';
import type { BookingFlowRepository } from './booking-flow.repository.js';
import type { BookingFlowService } from './services/booking-flow.service.js';
import type { BookingConfirmationService } from './services/booking-confirmation.service.js';

afterEach(() => vi.restoreAllMocks());

describe('BookingFlowWorker saga recovery', () => {
  it('uses durable saga backoff and dead-letters repeated refund failures', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    let attempts = 0;
    const repository = {
      expireAllDue: vi.fn().mockResolvedValue([]),
      claimResumable: vi
        .fn()
        .mockResolvedValue([{ id: 'booking', flowState: 'refunding' }]),
      claimCompensable: vi.fn().mockResolvedValue([]),
      findChargedWithoutOutcome: vi.fn().mockResolvedValue([]),
      deferSaga: vi.fn(async () => ++attempts),
      deferResume: vi.fn(),
      deadLetterCompensation: vi.fn(),
    };
    const worker = new BookingFlowWorker(
      repository as unknown as BookingFlowRepository,
      {} as BookingFlowService,
      {
        run: vi.fn().mockRejectedValue(new Error('refund refused')),
      } as unknown as BookingConfirmationService,
    );
    for (let attempt = 0; attempt < 12; attempt++) await worker.scan();
    expect(repository.deferSaga).toHaveBeenCalledTimes(12);
    expect(repository.deferResume).not.toHaveBeenCalled();
    expect(repository.deadLetterCompensation).toHaveBeenCalledWith(
      'booking',
      12,
      'refund refused',
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('DEAD LETTER'),
    );
  });

  it('logs charged bookings after the sixty-second threshold', async () => {
    const errorLog = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const findChargedWithoutOutcome = vi
      .fn()
      .mockResolvedValue([{ id: 'booking', sagaStep: 'refunding' }]);
    const worker = new BookingFlowWorker(
      {
        expireAllDue: async () => [],
        claimResumable: async () => [],
        claimCompensable: async () => [],
        findChargedWithoutOutcome,
      } as unknown as BookingFlowRepository,
      {} as BookingFlowService,
      {} as BookingConfirmationService,
    );
    await worker.scan();
    expect(findChargedWithoutOutcome).toHaveBeenCalledWith(60);
    expect(errorLog).toHaveBeenCalledWith(
      'ALERT: booking booking was charged and is still refunding',
    );
  });
});
