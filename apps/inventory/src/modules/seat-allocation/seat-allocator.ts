import { AllocationOutcome } from '@app/contracts';
import type {
  AllocatableSeat,
  AllocateGroupSeatsInput,
  AllocatedSeatAssignment,
  AllocationResult,
} from './seat-allocator.types.js';

interface CoachRow {
  rowNumber: number;
  leftSeats: AllocatableSeat[];
  rightSeats: AllocatableSeat[];
}

interface InternalCoach {
  coachNumber: number;
  rows: CoachRow[];
  freeSeats: AllocatableSeat[];
}

interface Tier2Candidate {
  rowSpan: number;
  pairCount: number;
  coachNumber: number;
  startingRow: number;
  seats: AllocatableSeat[];
}

interface Tier3Candidate {
  coachesUsed: number;
  pairCount: number;
  coachNumbers: number[];
  seats: AllocatableSeat[];
}

/**
 * Counts the maximum number of disjoint 2-seat companion pairs in a list of seats.
 * A companion pair must be in the same coach, same row, same aisle side,
 * and occupy adjacent seat indices.
 */
export function countCompanionPairs(seats: AllocatableSeat[]): number {
  const groups = new Map<string, number[]>();
  for (const s of seats) {
    const key = `${s.coachNumber}:${s.rowNumber}:${s.side}`;
    let indices = groups.get(key);
    if (!indices) {
      indices = [];
      groups.set(key, indices);
    }
    indices.push(s.seatIndexInSide);
  }

  let totalPairs = 0;
  for (const indices of groups.values()) {
    indices.sort((a, b) => a - b);
    let i = 0;
    while (i < indices.length - 1) {
      if (indices[i + 1] === indices[i] + 1) {
        totalPairs++;
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return totalPairs;
}

/**
 * Generates all combinations of size k from an array.
 */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  if (arr.length === k) return [arr.slice()];
  const head = arr[0];
  const tail = arr.slice(1);
  const withHead = combinations(tail, k - 1).map((c) => [head, ...c]);
  const withoutHead = combinations(tail, k);
  return [...withHead, ...withoutHead];
}

/**
 * Partitions a sum into k parts where each part is an integer >= 1 and <= limits[index].
 */
function getPartitions(
  sum: number,
  k: number,
  limits: number[],
  index: number = 0,
): number[][] {
  if (k === 1) {
    if (sum >= 1 && sum <= limits[index]) {
      return [[sum]];
    }
    return [];
  }
  const result: number[][] = [];
  const minPart = 1;
  const maxPart = Math.min(sum - (k - 1), limits[index]);
  for (let m = minPart; m <= maxPart; m++) {
    const subPartitions = getPartitions(sum - m, k - 1, limits, index + 1);
    for (const sub of subPartitions) {
      result.push([m, ...sub]);
    }
  }
  return result;
}

/**
 * Groups flat trip_seat rows into coaches, rows and aisle sides. Row and seat
 * order come from row_number and seat_index_in_side, so the engine sees the
 * physical layout without being handed one.
 */
function groupIntoCoaches(
  seats: AllocatableSeat[],
  occupiedSeatIds: Set<string>,
): InternalCoach[] {
  const byCoach = new Map<number, Map<number, CoachRow>>();

  for (const seat of seats) {
    let rows = byCoach.get(seat.coachNumber);
    if (!rows) {
      rows = new Map();
      byCoach.set(seat.coachNumber, rows);
    }
    let row = rows.get(seat.rowNumber);
    if (!row) {
      row = { rowNumber: seat.rowNumber, leftSeats: [], rightSeats: [] };
      rows.set(seat.rowNumber, row);
    }
    (seat.side === 'left' ? row.leftSeats : row.rightSeats).push(seat);
  }

  return [...byCoach.entries()]
    .sort(([a], [b]) => a - b)
    .map(([coachNumber, rowsByNumber]) => {
      const rows = [...rowsByNumber.values()].sort(
        (a, b) => a.rowNumber - b.rowNumber,
      );
      const freeSeats: AllocatableSeat[] = [];

      for (const row of rows) {
        for (const side of [row.leftSeats, row.rightSeats]) {
          side.sort((a, b) => a.seatIndexInSide - b.seatIndexInSide);
          for (const seat of side) {
            if (!occupiedSeatIds.has(seat.seatId)) freeSeats.push(seat);
          }
        }
      }

      return { coachNumber, rows, freeSeats };
    });
}

/**
 * Tier 1 evaluation for Solo Traveller (Group of 1).
 * Preference hierarchy:
 * 1. Broken pair (seat on a multi-seat side where at least one companion seat is occupied).
 * 2. Isolated seat (only seat on its aisle side in that row).
 * 3. First available seat (intact pair / cluster).
 * Tie-breaker within category: lowest coachNumber, lowest rowNumber, left before right, lowest seat index.
 */
function evaluateTier1Solo(
  coaches: InternalCoach[],
  isFree: (seat: AllocatableSeat) => boolean,
): AllocatableSeat | null {
  interface CandidateSeat {
    category: 1 | 2 | 3; // 1 = broken pair, 2 = isolated seat, 3 = intact
    seat: AllocatableSeat;
  }

  const candidates: CandidateSeat[] = [];

  for (const coach of coaches) {
    for (const row of coach.rows) {
      for (const sideSeats of [row.leftSeats, row.rightSeats]) {
        if (sideSeats.length === 0) continue;

        const freeOnSide = sideSeats.filter(isFree);
        if (freeOnSide.length === 0) continue;

        let category: 1 | 2 | 3;
        if (sideSeats.length === 1) {
          category = 2; // Isolated seat
        } else if (freeOnSide.length < sideSeats.length) {
          category = 1; // Broken pair (at least one companion is occupied)
        } else {
          category = 3; // Intact pair / cluster (all seats on side are free)
        }

        for (const freeSeat of freeOnSide) {
          candidates.push({ category, seat: freeSeat });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // 1. Category preference: 1 (broken) < 2 (isolated) < 3 (intact)
    if (a.category !== b.category) {
      return a.category - b.category;
    }
    // 2. Lowest coachNumber
    if (a.seat.coachNumber !== b.seat.coachNumber) {
      return a.seat.coachNumber - b.seat.coachNumber;
    }
    // 3. Lowest rowNumber
    if (a.seat.rowNumber !== b.seat.rowNumber) {
      return a.seat.rowNumber - b.seat.rowNumber;
    }
    // 4. Left over right
    if (a.seat.side !== b.seat.side) {
      return a.seat.side === 'left' ? -1 : 1;
    }
    // 5. Lowest seat index
    return a.seat.seatIndexInSide - b.seat.seatIndexInSide;
  });

  return candidates[0].seat;
}

/**
 * Tier 1 evaluation for Group of 2.
 * Looks for 2 adjacent seats in the same row on the same aisle side.
 * Tie-breaks: lowest coachNumber, lowest starting rowNumber, left over right, lowest seat index.
 */
function evaluateTier1Group2(
  coaches: InternalCoach[],
  isFree: (seat: AllocatableSeat) => boolean,
): AllocatableSeat[] | null {
  for (const coach of coaches) {
    for (const row of coach.rows) {
      for (const sideSeats of [row.leftSeats, row.rightSeats]) {
        for (let c = 0; c < sideSeats.length - 1; c++) {
          const s1 = sideSeats[c];
          const s2 = sideSeats[c + 1];
          if (isFree(s1) && isFree(s2)) {
            return [s1, s2];
          }
        }
      }
    }
  }
  return null;
}

/**
 * Tier 1 evaluation for Group of 3.
 * Priority 1: 3 contiguous seats in the same row on the same side.
 * Priority 2: 2+1 cluster on the same side across adjacent rows.
 */
function evaluateTier1Group3(
  coaches: InternalCoach[],
  isFree: (seat: AllocatableSeat) => boolean,
): AllocatableSeat[] | null {
  // Pass 1: 3 contiguous seats in the same row
  for (const coach of coaches) {
    for (const row of coach.rows) {
      for (const sideSeats of [row.leftSeats, row.rightSeats]) {
        for (let c = 0; c < sideSeats.length - 2; c++) {
          const s1 = sideSeats[c];
          const s2 = sideSeats[c + 1];
          const s3 = sideSeats[c + 2];
          if (isFree(s1) && isFree(s2) && isFree(s3)) {
            return [s1, s2, s3];
          }
        }
      }
    }
  }

  // Pass 2: 2+1 cluster across adjacent rows on the same side
  for (const coach of coaches) {
    for (let r = 0; r < coach.rows.length; r++) {
      const row1 = coach.rows[r];
      const row2 = coach.rows.find((rw) => rw.rowNumber === row1.rowNumber + 1);
      if (!row2) continue;

      for (const side of ['left', 'right'] as const) {
        const side1 = side === 'left' ? row1.leftSeats : row1.rightSeats;
        const side2 = side === 'left' ? row2.leftSeats : row2.rightSeats;

        // Configuration A: Pair in row 1, single seat in row 2
        for (let c = 0; c < side1.length - 1; c++) {
          const p1 = side1[c];
          const p2 = side1[c + 1];
          if (isFree(p1) && isFree(p2)) {
            // Check aligned seat in row 2 at index c or c+1
            const candidatesInRow2 = [side2[c], side2[c + 1]].filter(
              (s): s is AllocatableSeat => s !== undefined && isFree(s),
            );
            if (candidatesInRow2.length > 0) {
              return [p1, p2, candidatesInRow2[0]];
            }
          }
        }

        // Configuration B: Single seat in row 1, pair in row 2
        for (let c = 0; c < side2.length - 1; c++) {
          const p1 = side2[c];
          const p2 = side2[c + 1];
          if (isFree(p1) && isFree(p2)) {
            // Check aligned seat in row 1 at index c or c+1
            const candidatesInRow1 = [side1[c], side1[c + 1]].filter(
              (s): s is AllocatableSeat => s !== undefined && isFree(s),
            );
            if (candidatesInRow1.length > 0) {
              return [candidatesInRow1[0], p1, p2];
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Tier 1 evaluation for Group of 4.
 * Looks for a 2x2 index-aligned block across adjacent rows (K and K+1) on the same aisle side.
 */
function evaluateTier1Group4(
  coaches: InternalCoach[],
  isFree: (seat: AllocatableSeat) => boolean,
): AllocatableSeat[] | null {
  for (const coach of coaches) {
    for (let r = 0; r < coach.rows.length; r++) {
      const row1 = coach.rows[r];
      const row2 = coach.rows.find((rw) => rw.rowNumber === row1.rowNumber + 1);
      if (!row2) continue;

      for (const side of ['left', 'right'] as const) {
        const side1 = side === 'left' ? row1.leftSeats : row1.rightSeats;
        const side2 = side === 'left' ? row2.leftSeats : row2.rightSeats;
        const maxIndex = Math.min(side1.length, side2.length) - 1;

        for (let c = 0; c < maxIndex; c++) {
          const r1c1 = side1[c];
          const r1c2 = side1[c + 1];
          const r2c1 = side2[c];
          const r2c2 = side2[c + 1];

          if (isFree(r1c1) && isFree(r1c2) && isFree(r2c1) && isFree(r2c2)) {
            return [r1c1, r1c2, r2c1, r2c2];
          }
        }
      }
    }
  }
  return null;
}

/**
 * Compares two Tier 2 candidate selections based on mandated tie-breaks:
 * 1. Smallest row span.
 * 2. Highest number of 2-seat companion pairs.
 * 3. Lowest coachNumber.
 * 4. Lowest starting rowNumber.
 * 5. Lowest seat order.
 */
function compareTier2Candidates(
  candA: Tier2Candidate,
  candB: Tier2Candidate,
): number {
  if (candA.rowSpan !== candB.rowSpan) {
    return candA.rowSpan - candB.rowSpan;
  }
  if (candA.pairCount !== candB.pairCount) {
    return candB.pairCount - candA.pairCount;
  }
  if (candA.coachNumber !== candB.coachNumber) {
    return candA.coachNumber - candB.coachNumber;
  }
  if (candA.startingRow !== candB.startingRow) {
    return candA.startingRow - candB.startingRow;
  }
  return compareSeatOrder(candA.seats, candB.seats);
}

/** Lowest row, left before right, lowest seat index, then seat number. */
function compareSeatOrder(
  seatsA: AllocatableSeat[],
  seatsB: AllocatableSeat[],
): number {
  for (let i = 0; i < seatsA.length; i++) {
    const sA = seatsA[i];
    const sB = seatsB[i];
    if (sA.rowNumber !== sB.rowNumber) return sA.rowNumber - sB.rowNumber;
    if (sA.side !== sB.side) return sA.side === 'left' ? -1 : 1;
    if (sA.seatIndexInSide !== sB.seatIndexInSide) {
      return sA.seatIndexInSide - sB.seatIndexInSide;
    }
    const cmp = sA.seatNumber.localeCompare(sB.seatNumber);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Evaluates Tier 2: Same Coach (SAME_COACH).
 * Finds the candidate selection of groupSize seats in a single coach minimizing row span.
 */
function evaluateTier2(
  coaches: InternalCoach[],
  groupSize: number,
): AllocatableSeat[] | null {
  const eligibleCoaches = coaches.filter(
    (c) => c.freeSeats.length >= groupSize,
  );
  if (eligibleCoaches.length === 0) return null;

  let bestCandidate: Tier2Candidate | null = null;

  for (const coach of eligibleCoaches) {
    const freeSeats = coach.freeSeats;
    const uniqueRows = Array.from(
      new Set(freeSeats.map((s) => s.rowNumber)),
    ).sort((a, b) => a - b);

    // Find the minimum row span in this coach
    let coachMinSpan = Infinity;
    for (let i = 0; i < uniqueRows.length; i++) {
      for (let j = i; j < uniqueRows.length; j++) {
        const rA = uniqueRows[i];
        const rB = uniqueRows[j];
        const seatsInSpan = freeSeats.filter(
          (s) => s.rowNumber >= rA && s.rowNumber <= rB,
        );
        if (seatsInSpan.length >= groupSize) {
          const span = rB - rA;
          if (span < coachMinSpan) {
            coachMinSpan = span;
          }
          break; // Since uniqueRows is sorted, j+1 will only have >= span
        }
      }
    }

    // Inspect windows that achieve coachMinSpan
    for (let i = 0; i < uniqueRows.length; i++) {
      for (let j = i; j < uniqueRows.length; j++) {
        const rA = uniqueRows[i];
        const rB = uniqueRows[j];
        if (rB - rA !== coachMinSpan) continue;

        const windowSeats = freeSeats.filter(
          (s) => s.rowNumber >= rA && s.rowNumber <= rB,
        );
        if (windowSeats.length < groupSize) continue;

        // Generate combinations of size groupSize from windowSeats
        const candidateSubsets = combinations(windowSeats, groupSize);
        for (const subset of candidateSubsets) {
          const minRow = Math.min(...subset.map((s) => s.rowNumber));
          const maxRow = Math.max(...subset.map((s) => s.rowNumber));
          if (minRow !== rA || maxRow !== rB) continue;

          const cand: Tier2Candidate = {
            rowSpan: coachMinSpan,
            pairCount: countCompanionPairs(subset),
            coachNumber: coach.coachNumber,
            startingRow: rA,
            seats: subset,
          };

          if (
            !bestCandidate ||
            compareTier2Candidates(cand, bestCandidate) < 0
          ) {
            bestCandidate = cand;
          }
        }
      }
    }
  }

  return bestCandidate ? bestCandidate.seats : null;
}

/**
 * Compares two Tier 3 candidate selections:
 * 1. Fewest coaches used.
 * 2. Highest count of companion pairs.
 * 3. Lowest coach numbers (lexicographically).
 * 4. Lowest row numbers and seat order.
 */
function compareTier3Candidates(
  candA: Tier3Candidate,
  candB: Tier3Candidate,
): number {
  if (candA.coachesUsed !== candB.coachesUsed) {
    return candA.coachesUsed - candB.coachesUsed;
  }
  if (candA.pairCount !== candB.pairCount) {
    return candB.pairCount - candA.pairCount;
  }
  for (
    let i = 0;
    i < Math.min(candA.coachNumbers.length, candB.coachNumbers.length);
    i++
  ) {
    if (candA.coachNumbers[i] !== candB.coachNumbers[i]) {
      return candA.coachNumbers[i] - candB.coachNumbers[i];
    }
  }
  return compareSeatOrder(candA.seats, candB.seats);
}

/**
 * Evaluates Tier 3: Minimal Coach Split (SPLIT).
 * Partitions groupSize across the minimum number of coaches while maximizing companion pairs.
 */
function evaluateTier3(
  coaches: InternalCoach[],
  groupSize: number,
): AllocatableSeat[] | null {
  const coachesWithSeats = coaches.filter((c) => c.freeSeats.length > 0);
  if (coachesWithSeats.length === 0) return null;

  // Try coach counts K from 2 up to min(coachesWithSeats.length, groupSize)
  for (let k = 2; k <= Math.min(coachesWithSeats.length, groupSize); k++) {
    const coachCombinations = combinations(coachesWithSeats, k);
    let bestForK: Tier3Candidate | null = null;

    for (const coachGroup of coachCombinations) {
      const limits = coachGroup.map((c) => c.freeSeats.length);
      const totalSeatsInGroup = limits.reduce((acc, n) => acc + n, 0);
      if (totalSeatsInGroup < groupSize) continue;

      const partitions = getPartitions(groupSize, k, limits);

      for (const partition of partitions) {
        // For each coach in coachGroup, pick partition[i] seats
        const perCoachSubsets: AllocatableSeat[][][] = coachGroup.map(
          (c, idx) => combinations(c.freeSeats, partition[idx]),
        );

        // Cartesian product of seat choices across the k coaches
        let currentCross: AllocatableSeat[][] = perCoachSubsets[0];
        for (let idx = 1; idx < k; idx++) {
          const nextLevel: AllocatableSeat[][] = [];
          for (const acc of currentCross) {
            for (const item of perCoachSubsets[idx]) {
              nextLevel.push([...acc, ...item]);
            }
          }
          currentCross = nextLevel;
        }

        for (const fullSelection of currentCross) {
          const cand: Tier3Candidate = {
            coachesUsed: k,
            pairCount: countCompanionPairs(fullSelection),
            coachNumbers: coachGroup.map((c) => c.coachNumber),
            seats: fullSelection,
          };

          if (!bestForK || compareTier3Candidates(cand, bestForK) < 0) {
            bestForK = cand;
          }
        }
      }
    }

    if (bestForK) {
      return bestForK.seats;
    }
  }

  return null;
}

/**
 * Pure group seat allocation engine.
 * Deterministic allocation across 3 strict fallback tiers:
 * SIDE_BY_SIDE -> SAME_COACH -> SPLIT.
 * Zero database, network, or clock dependencies.
 */
export function allocateGroupSeats(
  input: AllocateGroupSeatsInput,
): AllocationResult {
  const { groupSize, seats, occupiedSeatIds, passengerIds } = input;

  const occupied = new Set(occupiedSeatIds ?? []);
  const isFree = (seat: AllocatableSeat): boolean => !occupied.has(seat.seatId);
  const coaches = groupIntoCoaches(seats, occupied);

  const availableCount = coaches.reduce(
    (acc, c) => acc + c.freeSeats.length,
    0,
  );

  // Pre-check (All-or-Nothing Refusal)
  if (availableCount < groupSize) {
    return {
      success: false,
      error: 'INSUFFICIENT_SEATS',
      availableCount,
    };
  }

  // Tier 1: SIDE_BY_SIDE
  let tier1Seats: AllocatableSeat[] | null = null;
  if (groupSize === 1) {
    const soloSeat = evaluateTier1Solo(coaches, isFree);
    tier1Seats = soloSeat ? [soloSeat] : null;
  } else if (groupSize === 2) {
    tier1Seats = evaluateTier1Group2(coaches, isFree);
  } else if (groupSize === 3) {
    tier1Seats = evaluateTier1Group3(coaches, isFree);
  } else if (groupSize === 4) {
    tier1Seats = evaluateTier1Group4(coaches, isFree);
  }

  if (tier1Seats) {
    return formatResult(
      AllocationOutcome.SIDE_BY_SIDE,
      tier1Seats,
      passengerIds,
    );
  }

  // Tier 2: SAME_COACH
  const tier2Seats = evaluateTier2(coaches, groupSize);
  if (tier2Seats) {
    return formatResult(AllocationOutcome.SAME_COACH, tier2Seats, passengerIds);
  }

  // Tier 3: SPLIT
  const tier3Seats = evaluateTier3(coaches, groupSize);
  if (tier3Seats) {
    return formatResult(AllocationOutcome.SPLIT, tier3Seats, passengerIds);
  }

  // Fallback refusal if somehow unreachable
  return {
    success: false,
    error: 'INSUFFICIENT_SEATS',
    availableCount,
  };
}

function formatResult(
  outcome: AllocationOutcome,
  seats: AllocatableSeat[],
  passengerIds?: string[],
): AllocationResult {
  const assignedSeats: AllocatedSeatAssignment[] = seats.map((s, index) => {
    const assignment: AllocatedSeatAssignment = {
      seatId: s.seatId,
      coachNumber: s.coachNumber,
      seatNumber: s.seatNumber,
      rowNumber: s.rowNumber,
      label: `Coach ${s.coachNumber} · Seat ${s.seatNumber}`,
    };
    if (passengerIds && passengerIds[index]) {
      assignment.passengerId = passengerIds[index];
    }
    return assignment;
  });

  return {
    success: true,
    outcome,
    seats: assignedSeats,
  };
}
