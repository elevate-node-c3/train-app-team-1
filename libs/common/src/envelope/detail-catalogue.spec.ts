import { describe, expect, it } from 'vitest';

import { DETAIL_CATALOGUE, resolveDetailText } from './detail-catalogue.js';

describe('resolveDetailText', () => {
  it('returns the entry in the requested language', () => {
    expect(resolveDetailText('ACTION_DEFAULT', 'en')).toBe(
      "Send a value that meets this field's constraints.",
    );
    expect(resolveDetailText('ACTION_DEFAULT', 'ar')).toBe(
      'أرسل قيمة تطابق شروط هذا الحقل.',
    );
  });

  it('fills placeholders from params in both languages', () => {
    for (const lang of ['ar', 'en'] as const) {
      const text = resolveDetailText(
        'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        lang,
        { departureDate: '2026-12-01' },
      );
      expect(text).toContain('2026-12-01');
      expect(text).not.toContain('{{');
    }
  });

  it('leaves a placeholder intact when its param is missing', () => {
    const text = resolveDetailText('ACTION_PICK_RETURN_DATE_ON_OR_AFTER', 'en');
    expect(text).toContain('{{departureDate}}');
    expect(text).not.toContain('undefined');
  });

  it.each(['ISSUE_NO_SUCH_KEY', 'toString', '__proto__'])(
    'falls back to the generic entry for an unknown key %s',
    (key) => {
      for (const lang of ['ar', 'en'] as const) {
        expect(resolveDetailText(key, lang)).toBe(
          DETAIL_CATALOGUE.ISSUE_VALIDATION_FAILED[lang],
        );
      }
    },
  );
});

describe('DETAIL_CATALOGUE', () => {
  it('has non-empty ar and en for every entry', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(entry.ar.trim(), `${key}.ar`).not.toBe('');
      expect(entry.en.trim(), `${key}.en`).not.toBe('');
      expect(entry.ar, `${key}.ar`).not.toBe(entry.en);
    }
  });

  it('uses direct, standalone sentences in both languages', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(entry.ar, `${key}.ar`).not.toMatch(/يرجى|عفوا/);
      expect(entry.en, `${key}.en`).not.toMatch(/\bplease\b/i);
      expect(entry.ar, `${key}.ar`).toMatch(/[.!?]$/);
      expect(entry.en, `${key}.en`).toMatch(/[.!?]$/);
    }
  });

  it('names no payment vendor', () => {
    for (const [key, entry] of Object.entries(DETAIL_CATALOGUE)) {
      expect(`${entry.ar} ${entry.en}`.toLowerCase(), key).not.toContain(
        'stripe',
      );
    }
  });
});
