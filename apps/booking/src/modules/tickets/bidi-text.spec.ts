import { describe, expect, it } from 'vitest';

import { visualRuns } from './bidi-text.js';

/** The runs as they are drawn, left to right. */
const drawn = (text: string, direction: 'ltr' | 'rtl'): string[] =>
  visualRuns(text, direction).map((run) => run.text);

describe('visualRuns (RTL tickets)', () => {
  it('leaves an English line as one run', () => {
    expect(visualRuns('Second Class AC', 'ltr')).toEqual([
      { text: 'Second Class AC', rtl: false },
    ]);
  });

  it('never reverses Arabic letters: the font engine shapes and lays them out', () => {
    expect(visualRuns('الدرجة الثانية مكيفة', 'rtl')).toEqual([
      { text: 'الدرجة الثانية مكيفة', rtl: true },
    ]);
  });

  it('keeps a number inside Arabic text reading left to right', () => {
    // Read right to left: 27 أكتوبر 2025.
    expect(drawn('27 أكتوبر 2025', 'rtl')).toEqual(['2025', ' أكتوبر ', '27']);
  });

  it('places a train number where an Arabic reader expects it', () => {
    expect(drawn('رحلة 916 إلى القاهرة', 'rtl')).toEqual([
      ' إلى القاهرة',
      '916',
      'رحلة ',
    ]);
  });

  it('keeps an Arabic name inside an English line in reading order', () => {
    expect(drawn('Passenger: منى أحمد', 'ltr')).toEqual([
      'Passenger: ',
      'منى أحمد',
    ]);
  });

  it('draws nothing for an empty line', () => {
    expect(visualRuns('', 'rtl')).toEqual([]);
  });
});
