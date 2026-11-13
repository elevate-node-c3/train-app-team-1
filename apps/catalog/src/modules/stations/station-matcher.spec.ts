import { describe, expect, it } from 'vitest';
import {
  buildStationMatcher,
  type SearchableStation,
} from './station-matcher.js';

const sidiGaber: SearchableStation = {
  nameAr: 'سيدي جابر',
  nameEn: 'Sidi Gaber',
  altSpellings: [],
  cityNameAr: 'الإسكندرية',
  cityNameEn: 'Alexandria',
  governorateNameAr: 'الإسكندرية',
  governorateNameEn: 'Alexandria',
};

const elRaml: SearchableStation = {
  ...sidiGaber,
  nameAr: 'محطة الرمل',
  nameEn: 'El Raml Station',
  altSpellings: [],
};

const ramsis: SearchableStation = {
  nameAr: 'محطة رمسيس',
  nameEn: 'Ramsis Station',
  altSpellings: ['Ramses'],
  cityNameAr: 'القاهرة',
  cityNameEn: 'Cairo',
  governorateNameAr: 'القاهرة',
  governorateNameEn: 'Cairo',
};

const kafrElZayat: SearchableStation = {
  nameAr: 'كفر الزيات',
  nameEn: 'Kafr El Zayat',
  altSpellings: [],
  cityNameAr: 'كفر الزيات',
  cityNameEn: 'Kafr El Zayat',
  governorateNameAr: 'الغربية',
  governorateNameEn: 'Gharbia',
};

const tanta: SearchableStation = {
  nameAr: 'طنطا',
  nameEn: 'Tanta',
  altSpellings: [],
  cityNameAr: 'طنطا',
  cityNameEn: 'Tanta',
  governorateNameAr: 'الغربية',
  governorateNameEn: 'Gharbia',
};

const all = [sidiGaber, elRaml, ramsis, kafrElZayat, tanta];

function find(query: string): SearchableStation[] {
  return all.filter(buildStationMatcher(query));
}

describe('buildStationMatcher', () => {
  it('matches every station for an empty or blank query', () => {
    expect(find('')).toHaveLength(all.length);
    expect(find('   ')).toHaveLength(all.length);
  });

  it('finds Alexandria stations from every Arabic spelling and from "alex"', () => {
    for (const query of ['اسكندريه', 'إسكندرية', 'الاسكندرية', 'alex']) {
      expect(find(query)).toEqual([sidiGaber, elRaml]);
    }
  });

  it('matches from the start of any word', () => {
    expect(find('gaber')).toEqual([sidiGaber]);
    expect(find('sidi gab')).toEqual([sidiGaber]);
  });

  it('does not match from the middle of a word', () => {
    expect(find('aber')).toEqual([]);
  });

  it('finds a station typed with yeh instead of alef maksura', () => {
    expect(find('سيدى جابر')).toEqual([sidiGaber]);
  });

  it('ignores tashkeel in the query', () => {
    expect(find('طَنْطَا')).toEqual([tanta]);
  });

  it('ignores case, punctuation and hyphens', () => {
    expect(find('Kafr El-Zayat')).toEqual([kafrElZayat]);
    expect(find('kafr el zayat')).toEqual([kafrElZayat]);
  });

  it('matches alternative spellings', () => {
    expect(find('ramses')).toEqual([ramsis]);
    expect(find('ramsis')).toEqual([ramsis]);
  });

  it('matches by city and by governorate', () => {
    expect(find('tanta')).toEqual([tanta]);
    expect(find('gharbia')).toEqual([kafrElZayat, tanta]);
    expect(find('الغربية')).toEqual([kafrElZayat, tanta]);
  });

  it('treats % and _ as plain text that matches nothing', () => {
    expect(find('%')).toEqual([]);
    expect(find('_')).toEqual([]);
    expect(find('%%')).toEqual([]);
  });

  it('matches in both languages whatever the response language will be', () => {
    expect(find('طنطا')).toEqual([tanta]);
    expect(find('Tanta')).toEqual([tanta]);
  });
});
