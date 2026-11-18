import { describe, expect, it } from 'vitest';
import { AllocationOutcome } from '@app/contracts';
import { allocateGroupSeats } from './seat-allocator.js';
import type { AllocatableSeat } from './seat-allocator.types.js';

interface RowLayout {
  rowNumber: number;
  leftSeats: string[];
  rightSeats: string[];
}

/**
 * Flattens a readable row layout into trip_seat rows. seatId is
 * `${coachNumber}:${seatNumber}` so a test can name an occupied seat without
 * holding a uuid; production ids are trip_seat uuids.
 */
function seatsFromRows(
  coachNumber: number,
  rows: RowLayout[],
): AllocatableSeat[] {
  const seats: AllocatableSeat[] = [];
  for (const row of rows) {
    for (const side of ['left', 'right'] as const) {
      const numbers = side === 'left' ? row.leftSeats : row.rightSeats;
      numbers.forEach((seatNumber, seatIndexInSide) => {
        seats.push({
          seatId: `${coachNumber}:${seatNumber}`,
          coachNumber,
          rowNumber: row.rowNumber,
          side,
          seatIndexInSide,
          seatNumber,
        });
      });
    }
  }
  return seats;
}

/**
 * Standard 2+2 coach with N rows, numbered row by row:
 * row 1: left: ['1', '2'], right: ['3', '4']
 * row 2: left: ['5', '6'], right: ['7', '8'], etc.
 */
function standardCoach(
  coachNumber: number,
  rowCount: number = 5,
  seatsPerRowLeft: number = 2,
  seatsPerRowRight: number = 2,
): AllocatableSeat[] {
  const rows: RowLayout[] = [];
  let seatCounter = 1;
  for (let r = 1; r <= rowCount; r++) {
    const leftSeats: string[] = [];
    for (let c = 0; c < seatsPerRowLeft; c++) {
      leftSeats.push(String(seatCounter++));
    }
    const rightSeats: string[] = [];
    for (let c = 0; c < seatsPerRowRight; c++) {
      rightSeats.push(String(seatCounter++));
    }
    rows.push({ rowNumber: r, leftSeats, rightSeats });
  }
  return seatsFromRows(coachNumber, rows);
}

/** Everything the free list does not name is occupied. */
function occupiedExcept(
  seats: AllocatableSeat[],
  freeSeatIds: string[],
): string[] {
  const free = new Set(freeSeatIds);
  return seats.filter((s) => !free.has(s.seatId)).map((s) => s.seatId);
}

describe('Group Seat Allocation Engine (seat-allocator)', () => {
  describe('Pre-check: All-or-Nothing Refusal', () => {
    it('returns INSUFFICIENT_SEATS error when total free seats < groupSize', () => {
      const seats = standardCoach(1, 2); // 8 seats total
      // Only 2 seats free
      const free = ['1:1', '1:2'];

      const result = allocateGroupSeats({
        groupSize: 3,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result).toEqual({
        success: false,
        error: 'INSUFFICIENT_SEATS',
        availableCount: 2,
      });
    });

    it('returns INSUFFICIENT_SEATS with availableCount 0 when every seat is occupied', () => {
      const seats = standardCoach(1, 2);
      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: seats.map((s) => s.seatId),
      });

      expect(result).toEqual({
        success: false,
        error: 'INSUFFICIENT_SEATS',
        availableCount: 0,
      });
    });

    it('returns INSUFFICIENT_SEATS with availableCount 0 when the trip has no seats', () => {
      const result = allocateGroupSeats({
        groupSize: 1,
        seats: [],
      });

      expect(result).toEqual({
        success: false,
        error: 'INSUFFICIENT_SEATS',
        availableCount: 0,
      });
    });
  });

  describe('Tier 1: Solo Traveller (Group of 1)', () => {
    it('steers solo passenger to a broken pair within the same coach', () => {
      const seats = standardCoach(1, 2);
      // Row 1: seat 1, 2 (intact pair, both free)
      // Row 2: seat 5 is free, seat 6 is occupied (broken pair!)
      const free = ['1:1', '1:2', '1:5'];

      const result = allocateGroupSeats({
        groupSize: 1,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(1);
        expect(result.seats[0]).toMatchObject({
          coachNumber: 1,
          seatNumber: '5',
          rowNumber: 2,
        });
      }
    });

    it('steers solo passenger to a broken pair across coaches to preserve intact pairs in earlier coach', () => {
      // Coach 1 row 1: 1, 2 (intact pair). Coach 2 row 1: 1 free, 2 occupied.
      const seats = [...standardCoach(1, 1), ...standardCoach(2, 1)];
      const free = ['1:1', '1:2', '2:1'];

      const result = allocateGroupSeats({
        groupSize: 1,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats[0]).toMatchObject({
          coachNumber: 2,
          seatNumber: '1',
          rowNumber: 1,
        });
      }
    });

    it('prefers isolated single seat on 2+1 layout over breaking an intact pair', () => {
      // 2+1 layout, all free: left: ['1', '2'] (pair), right: ['3'] (isolated)
      const seats = standardCoach(1, 1, 2, 1);

      const result = allocateGroupSeats({ groupSize: 1, seats });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats[0]).toMatchObject({
          coachNumber: 1,
          seatNumber: '3',
          rowNumber: 1,
        });
      }
    });

    it('picks first seat (lowest coach, lowest row, left before right) when all pairs are intact', () => {
      const result = allocateGroupSeats({
        groupSize: 1,
        seats: standardCoach(1, 2),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats[0]).toMatchObject({
          coachNumber: 1,
          seatNumber: '1',
          rowNumber: 1,
        });
      }
    });
  });

  describe('Tier 1: Group of 2 (Side-by-Side Pairs)', () => {
    it('allocates 2 adjacent seats in the same row on the same aisle side', () => {
      const seats = standardCoach(1, 2);
      // Free seats: row 1 left: 1, 2
      const free = ['1:1', '1:2'];

      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(2);
        expect(result.seats[0].seatNumber).toBe('1');
        expect(result.seats[1].seatNumber).toBe('2');
        expect(result.seats[0].rowNumber).toBe(1);
        expect(result.seats[1].rowNumber).toBe(1);
      }
    });

    it('NEVER allocates across-the-aisle seats as side-by-side (Rule: aisle separation)', () => {
      const seats = standardCoach(1, 2);
      // Row 1 left: ['1', '2'], right: ['3', '4']
      // Seat 2 (left) and Seat 3 (right) are across the aisle.
      // If only 2 and 3 are free, they must NOT be treated as side-by-side!
      const free = ['1:2', '1:3'];

      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Must fall back to SAME_COACH because they are across the aisle!
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
      }
    });

    it('NEVER treats consecutive seat numbers across aisle as side-by-side', () => {
      // Seat numbers run consecutively across the aisle: row 1 is 44 | 45.
      const seats = seatsFromRows(5, [
        { rowNumber: 1, leftSeats: ['44'], rightSeats: ['45'] },
        { rowNumber: 2, leftSeats: ['46', '47'], rightSeats: ['48', '49'] },
      ]);
      const free = ['5:44', '5:45', '5:46', '5:47'];

      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        // Must choose row 2 pair (46, 47), NOT (44, 45) which crosses the aisle!
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['46', '47']);
      }
    });

    it('breaks ties: lowest coachNumber, then lowest starting rowNumber, then left over right', () => {
      const seats = [...standardCoach(1, 2), ...standardCoach(2, 2)];

      const result = allocateGroupSeats({ groupSize: 2, seats });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats[0].coachNumber).toBe(1);
        expect(result.seats[0].rowNumber).toBe(1);
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['1', '2']); // left over right
      }
    });
  });

  describe('Tier 1: Group of 3 (3-in-a-row or 2+1 cluster)', () => {
    it('prioritizes 3 contiguous seats in the same row on layouts with >= 3 seats per side', () => {
      // 3+2 layout: left has 3 seats, right has 2
      const seats = standardCoach(1, 3, 3, 2);

      const result = allocateGroupSeats({ groupSize: 3, seats });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(3);
        expect(result.seats.every((s) => s.rowNumber === 1)).toBe(true);
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['1', '2', '3']);
      }
    });

    it('allocates 2+1 cluster on same side across adjacent rows on a 2+2 layout (pair in row K, 1 in row K+1)', () => {
      const seats = standardCoach(1, 3, 2, 2);
      // Row 1 left: ['1', '2'] free, Row 2 left: ['5'] free
      const free = ['1:1', '1:2', '1:5'];

      const result = allocateGroupSeats({
        groupSize: 3,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(3);
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['1', '2', '5']);
      }
    });

    it('allocates 2+1 cluster when pair is in row K+1 and single seat is in row K', () => {
      const seats = standardCoach(1, 3, 2, 2);
      // Row 1 left: only 1 free. Row 2 left: 5 and 6 free.
      const free = ['1:1', '1:5', '1:6'];

      const result = allocateGroupSeats({
        groupSize: 3,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(3);
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['1', '5', '6']);
      }
    });
  });

  describe('Tier 1: Group of 4 (2x2 Column-Aligned Block)', () => {
    it('allocates a 2x2 column-aligned block across adjacent rows on the same side', () => {
      const seats = standardCoach(1, 3, 2, 2);
      // Row 1 left: ['1', '2'], Row 2 left: ['5', '6']
      const free = ['1:1', '1:2', '1:5', '1:6'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats).toHaveLength(4);
        expect(result.seats.map((s) => s.seatNumber)).toEqual([
          '1',
          '2',
          '5',
          '6',
        ]);
      }
    });

    it('falls back to SAME_COACH if coach has 4 seats free but not in a 2x2 block (e.g. across aisle)', () => {
      const seats = standardCoach(1, 2, 2, 2);
      // Row 1 left: 1, 2. Row 2 right: 7, 8 (different sides of aisle!)
      const free = ['1:1', '1:2', '1:7', '1:8'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
        expect(result.seats).toHaveLength(4);
      }
    });

    it('falls back to SAME_COACH if rows are not adjacent (e.g. row 1 and row 3)', () => {
      const seats = standardCoach(1, 3, 2, 2);
      // Row 1 left: 1, 2. Row 3 left: 9, 10 (skipped row 2!)
      const free = ['1:1', '1:2', '1:9', '1:10'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
      }
    });
  });

  describe('Tier 2: Same Coach (SAME_COACH)', () => {
    it('minimizes row span when Tier 1 is unavailable', () => {
      const seats = standardCoach(1, 10, 2, 2);
      // Available seats in coach 1:
      // Row 1 left: seat 1
      // Row 2 left: seat 5
      // Row 8 left: seat 29
      // Row 9 left: seat 33
      // Row 10 left: seat 37
      // Group of 3:
      // Candidate A: {1, 5, 29} -> row span 8 - 1 = 7
      // Candidate B: {29, 33, 37} -> row span 10 - 8 = 2 (winner!)
      const free = ['1:1', '1:5', '1:29', '1:33', '1:37'];

      const result = allocateGroupSeats({
        groupSize: 3,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
        expect(result.seats.map((s) => s.seatNumber)).toEqual([
          '29',
          '33',
          '37',
        ]);
      }
    });

    it('maximizes companion pairs when row span is tied', () => {
      const seats = standardCoach(1, 5, 2, 2);
      // Group of 4, two windows of span 1:
      // Rows 1 & 2: left 1, right 3, left 5, right 7 -> 0 pairs
      // Rows 4 & 5: left 13, 14 (pair), left 17, right 19 -> 1 pair (winner)
      const free = [
        '1:1',
        '1:3',
        '1:5',
        '1:7',
        '1:13',
        '1:14',
        '1:17',
        '1:19',
      ];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
        expect(result.seats.map((s) => s.seatNumber)).toEqual([
          '13',
          '14',
          '17',
          '19',
        ]);
      }
    });

    it('STRICTLY beats SPLIT even if split has pairs (Coach 3 scattered vs Coach 5 & 6 pairs)', () => {
      // Mandated rule check:
      // If Coach 3 has 4 scattered free seats and Coach 5 and 6 each have 2 adjacent seats,
      // a group of 4 MUST be placed in Coach 3 (SAME_COACH strictly beats SPLIT).
      const seats = [
        ...standardCoach(3, 4, 2, 2),
        ...standardCoach(5, 2, 2, 2),
        ...standardCoach(6, 2, 2, 2),
      ];
      // Coach 3: 4 scattered seats. Coach 5 and 6: one adjacent pair each.
      const free = [
        '3:1',
        '3:8',
        '3:9',
        '3:16',
        '5:1',
        '5:2',
        '6:1',
        '6:2',
      ];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
        expect(result.seats.every((s) => s.coachNumber === 3)).toBe(true);
        expect(result.seats).toHaveLength(4);
      }
    });

    it('falls back to SAME_COACH when coach has only 3 adjacent seats free and groupSize is 4', () => {
      // Mandated rule check:
      // If a coach has only 3 adjacent seats free and groupSize is 4,
      // it falls back to Tier 2 (SAME_COACH), not Tier 1.
      const seats = standardCoach(1, 5, 3, 2);
      // Row 1 left: ['1', '2', '3'] (3 adjacent seats), Row 5 left: ['17']
      const free = ['1:1', '1:2', '1:3', '1:17'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SAME_COACH);
        expect(result.seats.map((s) => s.seatNumber)).toEqual([
          '1',
          '2',
          '3',
          '17',
        ]);
      }
    });
  });

  describe('Tier 3: Minimal Coach Split (SPLIT)', () => {
    it('partitions across minimal number of coaches when no single coach has enough seats', () => {
      // Group of 4. Coach 1 and 2 have 2 seats each; coach 3 and 4 have 1 each.
      const seats = [
        ...standardCoach(1, 2),
        ...standardCoach(2, 2),
        ...standardCoach(3, 2),
        ...standardCoach(4, 2),
      ];
      const free = ['1:1', '1:2', '2:1', '2:2', '3:1', '4:1'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SPLIT);
        expect(result.seats).toHaveLength(4);
        // Uses 2 coaches (Coach 1 and Coach 2), not 3 coaches
        const coachesUsed = new Set(result.seats.map((s) => s.coachNumber));
        expect(coachesUsed.size).toBe(2);
        expect(coachesUsed).toEqual(new Set([1, 2]));
      }
    });

    it('maximizes 2-seat companion pairs across coach partitions', () => {
      // Group of 4 across 2 coaches. Coach 1 and 3 hold a pair each; coach 2 is
      // scattered, so coach 1 + 3 gives 2 pairs against 1.
      const seats = [
        ...standardCoach(1, 2),
        ...standardCoach(2, 2),
        ...standardCoach(3, 2),
      ];
      const free = ['1:1', '1:2', '2:1', '2:8', '3:1', '3:2'];

      const result = allocateGroupSeats({
        groupSize: 4,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SPLIT);
        const coachesUsed = new Set(result.seats.map((s) => s.coachNumber));
        // Must choose Coach 1 and Coach 3 because they maximize companion pairs!
        expect(coachesUsed).toEqual(new Set([1, 3]));
      }
    });

    it('breaks ties deterministically in SPLIT: lowest coach numbers, lowest row numbers', () => {
      // Group of 3; each coach has exactly one seat free at row 1 left.
      const seats = [
        ...standardCoach(1, 2),
        ...standardCoach(2, 2),
        ...standardCoach(3, 2),
      ];
      const free = ['1:1', '2:1', '3:1'];

      const result = allocateGroupSeats({
        groupSize: 3,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SPLIT);
        expect(result.seats.map((s) => s.coachNumber)).toEqual([1, 2, 3]);
      }
    });
  });

  describe('Determinism, Input Formats & Passenger Mapping', () => {
    it('is completely deterministic: identical inputs yield identical outputs across 50 runs', () => {
      const seats = [...standardCoach(1, 5), ...standardCoach(2, 5)];

      const firstResult = allocateGroupSeats({ groupSize: 4, seats });

      for (let i = 0; i < 50; i++) {
        expect(allocateGroupSeats({ groupSize: 4, seats })).toEqual(
          firstResult,
        );
      }
    });

    it('does not depend on the order seats arrive in', () => {
      const seats = standardCoach(1, 3, 2, 2);
      const free = ['1:1', '1:2', '1:5'];
      const occupiedSeatIds = occupiedExcept(seats, free);

      const inOrder = allocateGroupSeats({ groupSize: 3, seats, occupiedSeatIds });
      const shuffled = allocateGroupSeats({
        groupSize: 3,
        seats: [...seats].reverse(),
        occupiedSeatIds,
      });

      expect(shuffled).toEqual(inOrder);
    });

    it('accepts occupiedSeatIds as a Set', () => {
      const seats = standardCoach(1, 2);
      const free = ['1:1', '1:2'];

      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: new Set(occupiedExcept(seats, free)),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
        expect(result.seats.map((s) => s.seatNumber)).toEqual(['1', '2']);
      }
    });

    it('treats an omitted occupiedSeatIds as a wholly empty trip', () => {
      const seats = standardCoach(1, 2);

      const result = allocateGroupSeats({ groupSize: 2, seats });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seats).toHaveLength(2);
      }
    });

    it('returns the trip_seat id of every allocated seat', () => {
      const seats = standardCoach(1, 2);

      const result = allocateGroupSeats({ groupSize: 2, seats });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seats.map((s) => s.seatId)).toEqual(['1:1', '1:2']);
      }
    });

    it('maps passengerIds to allocated seats in assignment order', () => {
      const seats = standardCoach(1, 2);
      const free = ['1:1', '1:2', '1:5', '1:6'];

      const result = allocateGroupSeats({
        groupSize: 2,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
        passengerIds: ['passenger-alpha', 'passenger-beta'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seats[0].passengerId).toBe('passenger-alpha');
        expect(result.seats[1].passengerId).toBe('passenger-beta');
      }
    });

    it('generates human-readable label for each assigned seat', () => {
      const seats = seatsFromRows(5, [
        { rowNumber: 11, leftSeats: ['44', '45'], rightSeats: ['46', '47'] },
      ]);
      const free = ['5:44'];

      const result = allocateGroupSeats({
        groupSize: 1,
        seats,
        occupiedSeatIds: occupiedExcept(seats, free),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.seats[0].label).toBe('Coach 5 · Seat 44');
      }
    });
  });
});
