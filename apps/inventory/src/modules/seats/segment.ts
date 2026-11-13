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
  // Parse formats like [0,2) or [0,2]
  const match = literal.match(/^\[(\d+),(\d+)([)\]])$/);
  if (!match) {
    throw new Error(`Invalid int4range format: ${literal}`);
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

export function stationsInUse(segment: Segment): number[] {
  const stations: number[] = [];
  for (let i = segment.from; i <= segment.to; i += 1) {
    stations.push(i);
  }
  return stations;
}
