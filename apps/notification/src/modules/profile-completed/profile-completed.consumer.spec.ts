import { describe, expect, it, vi } from 'vitest';
import {
  PROFILE_COMPLETED_EVENT_TYPE,
  PROFILE_COMPLETED_VERSION,
  type EventEnvelope,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';
import { parseProfileCompletedPayload } from './profile-completed.parser.js';
import { ProfileCompletedConsumer } from './profile-completed.consumer.js';

describe('ProfileCompletedConsumer and Parser', () => {
  const validEnvelope: EventEnvelope = {
    id: '11111111-1111-4111-8111-111111111111',
    type: PROFILE_COMPLETED_EVENT_TYPE,
    version: PROFILE_COMPLETED_VERSION,
    occurredAt: '2026-10-28T12:00:00.000Z',
    correlationId: 'corr-1',
    producer: 'identity',
    payload: {
      accountId: 'acc-1',
      fullName: 'Ahmed Hussein',
      completedAt: '2026-10-28T12:00:00.000Z',
    },
  };

  describe('parseProfileCompletedPayload', () => {
    it('parses valid payload successfully', () => {
      const parsed = parseProfileCompletedPayload(validEnvelope);
      expect(parsed).toEqual({
        accountId: 'acc-1',
        fullName: 'Ahmed Hussein',
        completedAt: '2026-10-28T12:00:00.000Z',
      });
    });

    it('rejects non-object payload', () => {
      expect(() =>
        parseProfileCompletedPayload({ ...validEnvelope, payload: null }),
      ).toThrow(InvalidEventPayloadError);
    });

    it('rejects missing accountId', () => {
      expect(() =>
        parseProfileCompletedPayload({
          ...validEnvelope,
          payload: { fullName: 'Ahmed', completedAt: '2026-10-28T12:00:00.000Z' },
        }),
      ).toThrow(InvalidEventPayloadError);
    });

    it('rejects missing fullName', () => {
      expect(() =>
        parseProfileCompletedPayload({
          ...validEnvelope,
          payload: { accountId: 'acc-1', completedAt: '2026-10-28T12:00:00.000Z' },
        }),
      ).toThrow(InvalidEventPayloadError);
    });

    it('rejects invalid timestamp', () => {
      expect(() =>
        parseProfileCompletedPayload({
          ...validEnvelope,
          payload: { accountId: 'acc-1', fullName: 'Ahmed', completedAt: 'invalid-date' },
        }),
      ).toThrow(InvalidEventPayloadError);
    });
  });

  describe('ProfileCompletedConsumer', () => {
    it('upserts traveller profile and returns handled', async () => {
      const mockRepo = {
        upsert: vi.fn().mockResolvedValue(undefined),
      };
      const consumer = new ProfileCompletedConsumer(mockRepo as any);

      const result = await consumer.handle(validEnvelope);
      expect(result).toEqual({ status: 'handled' });
      expect(mockRepo.upsert).toHaveBeenCalledWith(
        'acc-1',
        'Ahmed Hussein',
        new Date('2026-10-28T12:00:00.000Z'),
      );
    });
  });
});

