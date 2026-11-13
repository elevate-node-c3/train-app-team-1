const TASHKEEL = /[\u0610-\u061A\u064B-\u065F\u0670]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0623\u0625\u0622\u0671]/g;
const TEH_MARBUTA = /\u0629/g;
const ALEF_MAKSURA = /\u0649/g;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

const DEFINITE_ARTICLE = '\u0627\u0644';

/**
 * One normalization for station names and queries (BR-22), so both sides
 * always end up in the same form.
 *
 * Arabic: alef variants become alef, teh marbuta becomes heh, alef maksura
 * becomes yeh, and tashkeel and tatweel are removed. A leading definite
 * article is dropped from each word.
 * English: lower case, and punctuation or hyphens count as spaces.
 *
 * Returns words separated by one space, or an empty string when nothing
 * searchable is left (for example the query "%").
 */
export function normalizeSearchText(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(TASHKEEL, '')
    .replace(TATWEEL, '')
    .replace(ALEF_VARIANTS, '\u0627')
    .replace(TEH_MARBUTA, '\u0647')
    .replace(ALEF_MAKSURA, '\u064A')
    .replace(NOT_LETTER_OR_DIGIT, ' ')
    .trim();

  if (cleaned === '') {
    return '';
  }

  return cleaned.split(' ').map(stripDefiniteArticle).join(' ');
}

function stripDefiniteArticle(word: string): string {
  // The length guard keeps a short word such as "ال" itself from vanishing.
  return word.startsWith(DEFINITE_ARTICLE) && word.length > 2
    ? word.slice(2)
    : word;
}
