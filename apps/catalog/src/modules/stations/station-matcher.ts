import { normalizeSearchText } from './normalize-search-text.js';

/** Everything a query may match against, in both languages. */
export interface SearchableStation {
  nameAr: string;
  nameEn: string;
  altSpellings: string[];
  cityNameAr: string;
  cityNameEn: string;
  governorateNameAr: string;
  governorateNameEn: string;
}

/** Normalized text of every field a query may match, in both languages. */
export function searchFieldsOf(station: SearchableStation): string[] {
  return [
    station.nameAr,
    station.nameEn,
    ...station.altSpellings,
    station.cityNameAr,
    station.cityNameEn,
    station.governorateNameAr,
    station.governorateNameEn,
  ].map(normalizeSearchText);
}

/**
 * Builds the predicate for one query (BR-22), over normalized search fields.
 *
 * A blank query matches everything. A query with nothing searchable left
 * after normalization (such as "%" or "_") matches nothing: those characters
 * are plain text, never wildcards, and no name contains them.
 */
export function buildFieldsMatcher(
  rawQuery: string,
): (fields: string[]) => boolean {
  if (rawQuery.trim() === '') {
    return () => true;
  }

  const query = normalizeSearchText(rawQuery);
  if (query === '') {
    return () => false;
  }

  return (fields) => fields.some((field) => startsAtWord(field, query));
}

export function buildStationMatcher(
  rawQuery: string,
): (station: SearchableStation) => boolean {
  const matches = buildFieldsMatcher(rawQuery);
  return (station) => matches(searchFieldsOf(station));
}

/** True when the query starts at the beginning of any word of the field. */
function startsAtWord(field: string, query: string): boolean {
  return field.startsWith(query) || field.includes(` ${query}`);
}
