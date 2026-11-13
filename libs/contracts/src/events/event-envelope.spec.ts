import { describe, expect, it } from 'vitest';
import type { SupportedLanguage } from '@app/common';
import {
  ENVELOPE_REQUIRED_KEYS,
  isEventEnvelope,
  type EventEnvelope,
  type EventLanguage,
} from '@app/contracts';

function envelope(): EventEnvelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'identity.verification-code.issued',
    version: 1,
    occurredAt: '2026-10-24T10:00:00.000Z',
    correlationId: 'corr-1',
    producer: 'identity',
    payload: { accountId: 'acc-1', code: '123456' },
  };
}

describe('Event envelope contract (ADR-0005, §10.C)', () => {
  // Type assertions keep both language unions compatible in both directions.
  it('keeps EventLanguage and SupportedLanguage mutually assignable', () => {
    const toSupported = (language: EventLanguage): SupportedLanguage => language;
    const toEvent = (language: SupportedLanguage): EventLanguage => language;

    expect(toSupported('ar')).toBe('ar');
    expect(toSupported('en')).toBe('en');
    expect(toEvent('ar')).toBe('ar');
    expect(toEvent('en')).toBe('en');
  });

  it('accepts a complete envelope', () => {
    expect(isEventEnvelope(envelope())).toBe(true);
  });

  it.each([...ENVELOPE_REQUIRED_KEYS])(
    'rejects an envelope missing %s',
    (key) => {
      const incomplete: Record<string, unknown> = { ...envelope() };
      delete incomplete[key];
      expect(isEventEnvelope(incomplete)).toBe(false);
    },
  );

  // Extra fields must remain valid without a version bump.
  it('accepts an envelope carrying an unknown extra key', () => {
    expect(isEventEnvelope({ ...envelope(), futureField: 'ok' })).toBe(true);
  });

  // Required keys must match a built envelope in its emitted order.
  it('lists exactly the keys a built envelope has', () => {
    expect(ENVELOPE_REQUIRED_KEYS).toEqual(Object.keys(envelope()));
  });
});
