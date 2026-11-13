import { describe, expect, it } from 'vitest';
import { verdictFor } from './publication-validation.js';
import { sixStopPayload, withTwoCoachesNumbered } from './seat-plan.fixture.js';

describe('verdictFor', () => {
  it('accepts a complete publication', () => {
    expect(verdictFor(sixStopPayload())).toEqual({ kind: 'usable' });
  });

  it('calls an empty coach list incomplete', () => {
    // Catalog may still be generating; retrying can fix this.
    expect(verdictFor({ ...sixStopPayload(), coaches: [] }).kind).toBe('incomplete');
  });

  it('calls a coach with no layout rows incomplete', () => {
    const payload = sixStopPayload();
    const coaches = [
      { ...payload.coaches[0], coachLayout: { ...payload.coaches[0].coachLayout, rows: [] } },
    ];
    expect(verdictFor({ ...payload, coaches }).kind).toBe('incomplete');
  });

  it('calls a layout whose rows hold no seats incomplete', () => {
    const payload = sixStopPayload();
    const emptyRows = [{ rowNumber: 1, leftSeats: [], rightSeats: [] }];
    const coaches = [
      { ...payload.coaches[0], coachLayout: { ...payload.coaches[0].coachLayout, rows: emptyRows } },
    ];
    expect(verdictFor({ ...payload, coaches }).kind).toBe('incomplete');
  });

  it('calls a one-stop trip malformed', () => {
    // No segment exists on a trip with fewer than two stops; retrying cannot help.
    const oneStop = sixStopPayload().stops[0];
    expect(verdictFor({ ...sixStopPayload(), stops: [oneStop] }).kind).toBe('malformed');
  });

  it('calls a duplicate station id malformed', () => {
    const payload = sixStopPayload();
    const stops = payload.stops.map((stop, index) =>
      index === 1 ? { ...stop, stationId: payload.stops[0].stationId } : stop,
    );
    expect(verdictFor({ ...payload, stops }).kind).toBe('malformed');
  });

  it('calls a duplicate coach number malformed', () => {
    // Review Focus 4: this would violate unique (trip_id, coach_number) inside
    // the all-or-nothing transaction and retry forever.
    expect(verdictFor(withTwoCoachesNumbered(5)).kind).toBe('malformed');
  });

  it('calls a seat number repeated inside one coach malformed', () => {
    // Review Focus 4: seat numbers are only unique per coach, not across coaches.
    const payload = sixStopPayload();
    const duplicateRows = [{ rowNumber: 1, leftSeats: ['1', '1'], rightSeats: [] }];
    const coaches = [
      {
        ...payload.coaches[0],
        coachLayout: { ...payload.coaches[0].coachLayout, rows: duplicateRows },
      },
    ];
    expect(verdictFor({ ...payload, coaches }).kind).toBe('malformed');
  });

  it('does not call a capacity mismatch a problem', () => {
    // The layout is the truth; capacity is a summary (spec §6.10).
    expect(verdictFor({ ...sixStopPayload(), capacity: 999 })).toEqual({ kind: 'usable' });
  });
});
