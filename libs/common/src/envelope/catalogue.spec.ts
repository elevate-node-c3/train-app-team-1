import type { SearchEmptyReason } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_SEARCH_DATE_OUT_OF_WINDOW,
  MESSAGE_CATALOGUE,
  resolveMessage,
  resolveMessageWithParams,
} from './catalogue.js';

/** Wire reason keys also index the localized messages. */
const EMPTY_REASON_KEYS: Exclude<
  SearchEmptyReason,
  'SEARCH_EMPTY_REASON_UNSPECIFIED'
>[] = [
  'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
  'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
  'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE',
  'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
  'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL',
];

describe('the search message catalogue', () => {
  it('speaks both languages for every empty-result reason', () => {
    for (const key of EMPTY_REASON_KEYS) {
      const entry = MESSAGE_CATALOGUE[key];

      expect(entry, `${key} is missing from the catalogue`).toBeDefined();
      expect(entry.ar.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
      // A reason that reads the same in both languages is an untranslated stub.
      expect(entry.ar).not.toBe(entry.en);
    }
  });

  it('gives every reason a different sentence', () => {
    for (const lang of ['ar', 'en'] as const) {
      const sentences = EMPTY_REASON_KEYS.map((key) =>
        resolveMessage(key, lang),
      );
      expect(new Set(sentences).size).toBe(EMPTY_REASON_KEYS.length);
    }
  });

  it('offers the return leg both ways out, quoting the arrival', () => {
    const message = resolveMessageWithParams(
      'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
      'en',
      { outboundArrivalTime: '23:50' },
    );

    expect(message).toContain('23:50');
    expect(message).toContain('return date');
    expect(message).toContain('outbound');
    expect(message).not.toContain('{{');
  });

  it('tells a filtered-out traveller to change the filters, not the date', () => {
    const message = resolveMessage(
      'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL',
      'en',
    );

    expect(message).toContain('filters');
    expect(message).toContain('are trains on this date');
  });

  it('uses the wording the story fixes for an empty date', () => {
    expect(resolveMessage('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE', 'en')).toBe(
      'Sorry, no trains available on the selected date',
    );
    expect(resolveMessage('SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE', 'ar')).toBe(
      'عفوا, لا يوجد مواعيد متاحة في التاريخ المختار',
    );
  });

  describe('resolveMessageWithParams', () => {
    it('states the last bookable date in both languages', () => {
      const params = { lastBookableDate: '2026-07-14' };

      for (const lang of ['ar', 'en'] as const) {
        const message = resolveMessageWithParams(
          CATALOG_SEARCH_DATE_OUT_OF_WINDOW,
          lang,
          params,
        );

        expect(message).toContain('2026-07-14');
        expect(message).not.toContain('{{');
      }
    });

    it('leaves a message with no placeholders untouched', () => {
      expect(
        resolveMessageWithParams('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED', 'en', {
          lastBookableDate: '2026-07-14',
        }),
      ).toBe(resolveMessage('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED', 'en'));
    });

    it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
      const message = resolveMessageWithParams(
        CATALOG_SEARCH_DATE_OUT_OF_WINDOW,
        'en',
        {},
      );

      expect(message).toContain('{{lastBookableDate}}');
    });

    it('falls back exactly as resolveMessage does for an unknown code', () => {
      expect(resolveMessageWithParams('NO_SUCH_CODE', 'en', {})).toBe(
        resolveMessage('NO_SUCH_CODE', 'en'),
      );
    });
  });
});
