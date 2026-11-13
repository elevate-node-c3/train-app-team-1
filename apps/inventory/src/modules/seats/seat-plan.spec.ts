import { describe, expect, it } from 'vitest';
import { seatPlanFrom } from './seat-plan.js';
import {
  payloadWithRow,
  payloadWithSeats,
  payloadWithStopPositions,
  sixStopPayload,
  twoStopPayload,
} from './seat-plan.fixture.js';

function totalSeatsIn(payload: ReturnType<typeof sixStopPayload>): number {
  return payload.coaches.reduce(
    (sum, coach) =>
      sum +
      coach.coachLayout.rows.reduce(
        (rowSum, row) => rowSum + row.leftSeats.length + row.rightSeats.length,
        0,
      ),
    0,
  );
}

describe('seatPlanFrom', () => {
  it('renumbers stops densely from zero, in catalog order', () => {
    // Catalog's positions were 10, 20, 30; range math needs 0, 1, 2.
    const payload = payloadWithStopPositions([30, 10, 20]);
    const [stopAt30, stopAt10, stopAt20] = payload.stops;

    const plan = seatPlanFrom(payload);

    expect(plan.stops.map((s) => s.position)).toEqual([0, 1, 2]);
    expect(plan.stops.map((s) => s.stationId)).toEqual([
      stopAt10.stationId,
      stopAt20.stationId,
      stopAt30.stationId,
    ]);
  });

  it('plans a seat for every seat in every row of every coach', () => {
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);
    expect(plan.seats).toHaveLength(totalSeatsIn(payload));
  });

  it('keeps a gap in seat numbering as given', () => {
    // A layout with no seat 13 is a layout, not an edge case.
    const plan = seatPlanFrom(payloadWithSeats(['11', '12', '14']));
    expect(plan.seats.map((s) => s.seatNumber)).toEqual(['11', '12', '14']);
  });

  it('records side and index so adjacency survives', () => {
    const plan = seatPlanFrom(
      payloadWithRow({ rowNumber: 3, leftSeats: ['A', 'B'], rightSeats: ['C'] }),
    );
    expect(plan.seats).toEqual([
      expect.objectContaining({ seatNumber: 'A', rowNumber: 3, side: 'left', seatIndexInSide: 0 }),
      expect.objectContaining({ seatNumber: 'B', rowNumber: 3, side: 'left', seatIndexInSide: 1 }),
      expect.objectContaining({ seatNumber: 'C', rowNumber: 3, side: 'right', seatIndexInSide: 0 }),
    ]);
  });

  it('copies each coach travel class onto its seats', () => {
    // Denormalised onto the seat row, spec §6.10.
    const payload = sixStopPayload();
    const plan = seatPlanFrom(payload);

    for (const coach of plan.coaches) {
      const seatsOfCoach = plan.seats.filter((seat) => seat.coachId === coach.id);
      expect(seatsOfCoach.length).toBeGreaterThan(0);
      for (const seat of seatsOfCoach) {
        expect(seat.travelClassId).toBe(coach.travelClassId);
      }
    }
  });

  it('reports a capacity mismatch without refusing it', () => {
    expect(seatPlanFrom({ ...sixStopPayload(), capacity: 999 }).capacityMismatch).toBe(999);
  });

  it('reports no mismatch when capacity agrees with the layout', () => {
    expect(seatPlanFrom(sixStopPayload()).capacityMismatch).toBeNull();
  });

  it('plans a two-stop trip', () => {
    // Review Focus 3.
    expect(seatPlanFrom(twoStopPayload()).stops.map((s) => s.position)).toEqual([0, 1]);
  });
});
