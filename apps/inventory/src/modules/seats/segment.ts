// Segment represents a half-open range [from, to) on the route: the seat is occupied
// from the origin station (inclusive) through the destination (exclusive).
// Touching segments do not overlap: [0,2) and [2,5) share a seat, but [0,5) and [1,2) collide.
export interface Segment {
  readonly from: number;
  readonly to: number;
}

export function segmentOf(from: number, to: number): Segment {
  if (from < 0 || to <= from) {
    throw new RangeError(`Invalid segment: from=${from}, to=${to}`);
  }
  return { from, to };
}

export function overlaps(a: Segment, b: Segment): boolean {
  return a.from < b.to && b.from < a.to;
}

export function toInt4Range(segment: Segment): string {
  return `[${segment.from},${segment.to})`;
}

export function parseInt4Range(literal: string): Segment {
  // Postgres normalizes to either bound style; we normalize to exclusive.
  const match = literal.match(/^\[(\d+),(\d+)([)\]])$/);
  if (!match) {
    throw new RangeError(`Invalid int4range format: ${literal}`);
  }

  const from = parseInt(match[1], 10);
  let to = parseInt(match[2], 10);
  const closeBracket = match[3];

  // If inclusive upper bound, increment to convert to exclusive
  if (closeBracket === ']') {
    to += 1;
  }

  return { from, to };
}

// Returns stations from origin to destination inclusive: the passenger occupies
// the destination station for fare/inventory purposes even though the seat is free from it.
export function stationsInUse(segment: Segment): number[] {
  const stations: number[] = [];
  for (let i = segment.from; i <= segment.to; i += 1) {
    stations.push(i);
  }
  return stations;
}
