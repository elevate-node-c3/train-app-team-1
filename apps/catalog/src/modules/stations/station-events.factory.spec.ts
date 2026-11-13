import { describe, expect, it } from 'vitest';
import { buildStationChanged } from './station-events.factory.js';
import { isEventEnvelope } from '@app/contracts';

describe('station changed event', () => {
  it('carries the immutable bilingual station snapshot with its transaction trace', () => {
    const payload = {
      stationId: 'station-id', action: 'updated' as const,
      nameAr: 'رمسيس', nameEn: 'Ramsis',
      cityId: 'city-id', governorateId: 'governorate-id',
      cityName: { ar: 'القاهرة', en: 'Cairo' },
      governorateName: { ar: 'القاهرة', en: 'Cairo' },
      altSpellings: ['Ramses'], isActive: false,
    };
    const event = buildStationChanged({ eventId: 'event-id', correlationId: 'trace-id', occurredAt: new Date('2026-11-13T00:00:00Z'), payload });
    expect(isEventEnvelope(event)).toBe(true);
    expect(event).toMatchObject({ id: 'event-id', type: 'catalog.station.changed', version: 1, producer: 'catalog', correlationId: 'trace-id', payload });
    expect(event.occurredAt).toBe('2026-11-13T00:00:00.000Z');
  });
});
