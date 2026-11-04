import type { SearchEmptyReason } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_SEARCH_DATE_OUT_OF_WINDOW,
  MESSAGE_CATALOGUE,
  resolveMessage,
  resolveMessageWithParams,
} from './catalogue.js';

/**
 * The reasons search can come back empty. Keyed by the wire enum value itself,
 * so there is no mapping table between the gRPC response and the sentence.
 */
const EMPTY_REASON_KEYS: Exclude<
  SearchEmptyReason,
  'SEARCH_EMPTY_REASON_UNSPECIFIED'
>[] = [
  'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
  'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
  'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE',
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

  it('gives the three reasons three different sentences', () => {
    // The whole point of BR-57: "change the stations" must not read like
    // "change the date".
    for (const lang of ['ar', 'en'] as const) {
      const sentences = EMPTY_REASON_KEYS.map((key) =>
        resolveMessage(key, lang),
      );
      expect(new Set(sentences).size).toBe(EMPTY_REASON_KEYS.length);
    }
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

        // BR-57: the refusal has to tell the traveller which date to pick
        // instead, not merely that this one is wrong.
        expect(message).toContain('2026-07-14');
        expect(message).not.toContain('{{');
      }
    });

    it('leaves a message with no placeholders untouched', () => {
      expect(
        resolveMessageWithParams(
          'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
          'en',
          { lastBookableDate: '2026-07-14' },
        ),
      ).toBe(resolveMessage('SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED', 'en'));
    });

    it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
      const message = resolveMessageWithParams(
        CATALOG_SEARCH_DATE_OUT_OF_WINDOW,
        'en',
        {},
      );

      // Failing loudly beats telling a traveller the last bookable date is
      // "undefined".
      expect(message).toContain('{{lastBookableDate}}');
    });

    it('falls back exactly as resolveMessage does for an unknown code', () => {
      expect(resolveMessageWithParams('NO_SUCH_CODE', 'en', {})).toBe(
        resolveMessage('NO_SUCH_CODE', 'en'),
      );
    });
  });
});
