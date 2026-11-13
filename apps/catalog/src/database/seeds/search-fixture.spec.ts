import { describe, expect, it } from 'vitest';

import {
  SEARCH_FIXTURE,
  SEARCH_FIXTURE_IDS,
  seatCapacityOf,
} from './search-fixture.js';

/**
 * Fixtures and generated trips share the search query's data contract.
 * Check references here for clearer failures than seed-time foreign-key errors.
 */
describe('the search fixture', () => {
  const stopsByTrip = new Map<string, typeof SEARCH_FIXTURE.tripStops>();
  for (const stop of SEARCH_FIXTURE.tripStops) {
    const existing = stopsByTrip.get(stop.tripId) ?? [];
    existing.push(stop);
    stopsByTrip.set(stop.tripId, existing);
  }

  it('describes every trip the scenarios need', () => {
    expect(SEARCH_FIXTURE.datedTrips.length).toBeGreaterThanOrEqual(6);
    expect(stopsByTrip.size).toBe(SEARCH_FIXTURE.datedTrips.length);
  });

  // Intermediate stops = destination.position - origin.position - 1;
  // positions must stay dense and one-based.
  it('numbers every trip stop densely from 1', () => {
    for (const [tripId, stops] of stopsByTrip) {
      const positions = stops
        .map((stop) => stop.position)
        .sort((a, b) => a - b);

      expect(positions, `${tripId} has gaps or duplicates`).toEqual(
        positions.map((_, index) => index + 1),
      );
    }
  });

  it('advances time along every route', () => {
    for (const [tripId, stops] of stopsByTrip) {
      const ordered = [...stops].sort((a, b) => a.position - b.position);

      let previous = Number.NEGATIVE_INFINITY;
      for (const stop of ordered) {
        for (const instant of [stop.arrivalAt, stop.departureAt]) {
          if (instant === null) continue;
          expect(
            instant.getTime(),
            `${tripId} position ${stop.position} goes backwards`,
          ).toBeGreaterThanOrEqual(previous);
          previous = instant.getTime();
        }
      }
    }
  });

  // Boarding needs a departure; alighting needs an arrival.
  it('gives the first stop a departure, the last an arrival, and interiors both', () => {
    for (const [tripId, stops] of stopsByTrip) {
      const ordered = [...stops].sort((a, b) => a.position - b.position);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];

      expect(first.departureAt, `${tripId} cannot be boarded`).not.toBeNull();
      expect(last.arrivalAt, `${tripId} cannot be alighted`).not.toBeNull();

      for (const stop of ordered.slice(1, -1)) {
        expect(
          stop.arrivalAt,
          `${tripId} position ${stop.position} has no arrival`,
        ).not.toBeNull();
        expect(
          stop.departureAt,
          `${tripId} position ${stop.position} has no departure`,
        ).not.toBeNull();
      }
    }
  });

  it('keeps every reference inside the fixture', () => {
    const ids = {
      governorate: new Set(SEARCH_FIXTURE.governorates.map((row) => row.id)),
      city: new Set(SEARCH_FIXTURE.cities.map((row) => row.id)),
      station: new Set(SEARCH_FIXTURE.stations.map((row) => row.id)),
      trainType: new Set(SEARCH_FIXTURE.trainTypes.map((row) => row.id)),
      travelClass: new Set(SEARCH_FIXTURE.travelClasses.map((row) => row.id)),
      coachLayout: new Set(SEARCH_FIXTURE.coachLayouts.map((row) => row.id)),
      train: new Set(SEARCH_FIXTURE.trains.map((row) => row.id)),
      timetable: new Set(SEARCH_FIXTURE.timetables.map((row) => row.id)),
      trip: new Set(SEARCH_FIXTURE.datedTrips.map((row) => row.id)),
    };

    for (const city of SEARCH_FIXTURE.cities) {
      expect(ids.governorate.has(city.governorateId)).toBe(true);
    }
    for (const station of SEARCH_FIXTURE.stations) {
      expect(ids.city.has(station.cityId)).toBe(true);
    }
    for (const train of SEARCH_FIXTURE.trains) {
      expect(ids.trainType.has(train.trainTypeId)).toBe(true);
    }
    for (const coach of SEARCH_FIXTURE.trainCoaches) {
      expect(ids.train.has(coach.trainId)).toBe(true);
      expect(ids.travelClass.has(coach.travelClassId)).toBe(true);
      expect(ids.coachLayout.has(coach.coachLayoutId)).toBe(true);
    }
    for (const stop of SEARCH_FIXTURE.timetableStops) {
      expect(ids.timetable.has(stop.timetableId)).toBe(true);
      expect(ids.station.has(stop.stationId)).toBe(true);
    }
    for (const trip of SEARCH_FIXTURE.datedTrips) {
      expect(ids.train.has(trip.trainId)).toBe(true);
      expect(ids.timetable.has(trip.timetableId)).toBe(true);
    }
    for (const stop of SEARCH_FIXTURE.tripStops) {
      expect(ids.trip.has(stop.tripId)).toBe(true);
      expect(ids.station.has(stop.stationId)).toBe(true);
    }
    for (const fare of SEARCH_FIXTURE.fares) {
      expect(ids.train.has(fare.trainId)).toBe(true);
      expect(ids.travelClass.has(fare.travelClassId)).toBe(true);
      expect(ids.station.has(fare.originStationId)).toBe(true);
      expect(ids.station.has(fare.destinationStationId)).toBe(true);
    }
  });

  it('snapshots a composition whose capacity matches its layout', () => {
    for (const trip of SEARCH_FIXTURE.datedTrips) {
      expect(trip.compositionSnapshot.length).toBeGreaterThan(0);

      for (const coach of trip.compositionSnapshot) {
        const counted = coach.coachLayout.rows.reduce(
          (total, row) => total + row.leftSeats.length + row.rightSeats.length,
          0,
        );
        expect(counted).toBeGreaterThan(0);
        expect(
          seatCapacityOf(trip, coach.travelClass.id),
        ).toBeGreaterThanOrEqual(counted);
      }
    }
  });

  describe('the scenarios the search specs rely on', () => {
    it('has a southbound trip with countable intermediate stops', () => {
      const stops = stopsByTrip.get(SEARCH_FIXTURE_IDS.trips.mainLine) ?? [];
      expect(stops.length).toBeGreaterThanOrEqual(5);
    });

    // Search by the passenger's origin departure date, even when service started the day before.
    it('has an overnight trip that departs a mid-route origin the next day', () => {
      const trip = SEARCH_FIXTURE.datedTrips.find(
        (row) => row.id === SEARCH_FIXTURE_IDS.trips.overnight,
      );
      const stops = (stopsByTrip.get(SEARCH_FIXTURE_IDS.trips.overnight) ?? [])
        .slice()
        .sort((a, b) => a.position - b.position);

      expect(trip).toBeDefined();
      const midRoute = stops[1];
      expect(midRoute.departureAt).not.toBeNull();
      expect(
        midRoute.departureAt!.toISOString().slice(0, 10) > trip!.serviceDate,
      ).toBe(true);
    });

    // Repeated station visits create multiple join pairs for one trip.
    it('has a route that calls at the same station twice', () => {
      const stops = stopsByTrip.get(SEARCH_FIXTURE_IDS.trips.loop) ?? [];
      const visits = stops.filter(
        (stop) => stop.stationId === SEARCH_FIXTURE_IDS.stations.banha,
      );

      expect(visits).toHaveLength(2);
    });

    it('has a train with no coach of the first class', () => {
      const trip = SEARCH_FIXTURE.datedTrips.find(
        (row) => row.id === SEARCH_FIXTURE_IDS.trips.singleClass,
      );

      expect(
        seatCapacityOf(trip!, SEARCH_FIXTURE_IDS.travelClasses.first),
      ).toBe(0);
      expect(
        seatCapacityOf(trip!, SEARCH_FIXTURE_IDS.travelClasses.second),
      ).toBeGreaterThan(0);
    });

    it('has three fares for one segment: past, current and future', () => {
      const segment = SEARCH_FIXTURE.fares.filter(
        (fare) =>
          fare.trainId === SEARCH_FIXTURE_IDS.trains.mainLine &&
          fare.travelClassId === SEARCH_FIXTURE_IDS.travelClasses.first &&
          fare.originStationId === SEARCH_FIXTURE_IDS.stations.alexandria &&
          fare.destinationStationId === SEARCH_FIXTURE_IDS.stations.ramsis,
      );

      expect(segment).toHaveLength(3);
      const amounts = new Set(segment.map((fare) => fare.amountPiastres));
      expect(amounts.size).toBe(3);
    });

    it('has a sellable segment with no fare at all', () => {
      const priced = SEARCH_FIXTURE.fares.some(
        (fare) => fare.trainId === SEARCH_FIXTURE_IDS.trains.singleClass,
      );

      expect(priced).toBe(false);
    });

    it('has a trip on the Cairo spring-forward date', () => {
      const trip = SEARCH_FIXTURE.datedTrips.find(
        (row) => row.id === SEARCH_FIXTURE_IDS.trips.springForward,
      );

      expect(trip?.serviceDate).toBe('2026-04-24');
    });

    it('has a draft and a withdrawn trip, which must never be sold', () => {
      const statuses = SEARCH_FIXTURE.datedTrips.map((trip) => trip.status);

      expect(statuses).toContain('draft');
      expect(statuses).toContain('withdrawn');
      expect(statuses).toContain('published');
    });

    it('has an inactive station, which must be refused rather than empty', () => {
      const inactive = SEARCH_FIXTURE.stations.filter((row) => !row.isActive);

      expect(inactive).toHaveLength(1);
      expect(inactive[0].id).toBe(SEARCH_FIXTURE_IDS.stations.inactive);
    });
  });
});
