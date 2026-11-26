import bidiModule from 'bidi-js';

// bidi-js's CommonJS build exports the factory itself, while its typings
// describe an ES default export; Node and Vite both hand us the function.
const bidiFactory: typeof bidiModule.default =
  typeof bidiModule === 'function' ? bidiModule : bidiModule.default;
const bidi = bidiFactory();

export type TextDirection = 'ltr' | 'rtl';

export interface VisualRun {
  text: string;
  rtl: boolean;
}

/**
 * Splits a line into runs in the order they are drawn, left to right.
 *
 * bidi-js resolves each character's embedding level (UAX #9); this applies
 * the reordering step (L2) to whole runs. A run's own text is left in logical
 * order on purpose: Arabic letters join by their logical neighbours, and the
 * font engine both shapes them and lays an Arabic run right-to-left. Reversing
 * the characters here would break the joining -- and a number inside Arabic
 * text ('27 أكتوبر 2025') would read backwards.
 */
export function visualRuns(
  text: string,
  direction: TextDirection,
): VisualRun[] {
  if (text.length === 0) return [];
  const { levels } = bidi.getEmbeddingLevels(text, direction);

  const runs: { text: string; level: number }[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || levels[index] !== levels[start]) {
      runs.push({ text: text.slice(start, index), level: levels[start] });
      start = index;
    }
  }

  const highest = Math.max(...runs.map((run) => run.level));
  const lowest = Math.min(...runs.map((run) => run.level));
  const lowestOdd = lowest % 2 === 1 ? lowest : lowest + 1;

  // L2: from the highest level down to the lowest odd one, reverse every
  // maximal sequence of runs at that level or above.
  for (let level = highest; level >= lowestOdd; level -= 1) {
    let index = 0;
    while (index < runs.length) {
      if (runs[index].level < level) {
        index += 1;
        continue;
      }
      let end = index;
      while (end + 1 < runs.length && runs[end + 1].level >= level) end += 1;
      runs.splice(
        index,
        end - index + 1,
        ...runs.slice(index, end + 1).reverse(),
      );
      index = end + 1;
    }
  }

  return runs.map((run) => ({ text: run.text, rtl: run.level % 2 === 1 }));
}
