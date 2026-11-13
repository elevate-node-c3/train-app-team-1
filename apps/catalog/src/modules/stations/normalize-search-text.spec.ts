import { describe, expect, it } from 'vitest';
import { normalizeSearchText } from './normalize-search-text.js';

describe('normalizeSearchText', () => {
  it('maps every spelling of Alexandria to one form', () => {
    const forms = ['اسكندريه', 'إسكندرية', 'الاسكندرية', 'الإسكندرية'];
    const normalized = new Set(forms.map(normalizeSearchText));
    expect(normalized).toEqual(new Set(['اسكندريه']));
  });

  it('treats alef maksura and yeh as the same letter', () => {
    expect(normalizeSearchText('سيدى جابر')).toBe(
      normalizeSearchText('سيدي جابر'),
    );
  });

  it('ignores a missing hamza', () => {
    expect(normalizeSearchText('اسيوط')).toBe(normalizeSearchText('أسيوط'));
    expect(normalizeSearchText('الاقصر')).toBe(normalizeSearchText('الأقصر'));
  });

  it('removes tashkeel', () => {
    expect(normalizeSearchText('طَنْطَا')).toBe(normalizeSearchText('طنطا'));
  });

  it('removes tatweel', () => {
    expect(normalizeSearchText('طنـــطا')).toBe(normalizeSearchText('طنطا'));
  });

  it('ignores case, punctuation and hyphens in English', () => {
    expect(normalizeSearchText('Kafr El-Zayat')).toBe('kafr el zayat');
    expect(normalizeSearchText('kafr el zayat')).toBe('kafr el zayat');
  });

  it('keeps a lone definite article', () => {
    expect(normalizeSearchText('ال')).toBe('ال');
  });

  it('returns an empty string when nothing searchable is left', () => {
    expect(normalizeSearchText('%')).toBe('');
    expect(normalizeSearchText('_')).toBe('');
    expect(normalizeSearchText('   ')).toBe('');
  });
});
