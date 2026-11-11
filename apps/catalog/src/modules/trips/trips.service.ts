import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ClsService } from 'nestjs-cls';
import {
  addCivilDays,
  BOOKING_WINDOW_DAYS,
  cairoInstantOf,
  cairoToday,
} from '@app/contracts';
import {
  tripGenerationEnabled,
  tripGenerationIntervalMs,
} from '../../config/trip-generation-settings.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import { FareEntity } from '../fares/entities/fare.entity.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { UNIT_OF_WORK } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import { randomUUID } from 'node:crypto';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import {
  buildTripPublished,
  buildTripWithdrawn,
} from './trip-events.factory.js';

/** One day past what search offers. The window itself is imported, never restated. */
const GENERATION_MARGIN_DAYS = 1;

/** A unique violation on `uq_dated_trip_train_date`. */
const UNIQUE_VIOLATION = '23505';

interface TripStopDraft {
  station: TimetableStopEntity['station'];
  stationId: string;
  position: number;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

/** One fare's amount and the instant it took effect. */
interface FarePrice {
  effectiveFrom: Date;
  amountPiastres: number;
}

/**
 * Every fare a train carries, keyed by class and station pair. Built from one
 * query so validating a trip costs no round trip per pair.
 */
type FareIndex = Map<string, FarePrice[]>;

function fareKey(
  travelClassId: string,
  originStationId: string,
  destinationStationId: string,
): string {
  return `${travelClassId}|${originStationId}|${destinationStationId}`;
}

@Injectable()
export class TripsService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TripsService.name);
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @InjectRepository(TimetableEntity)
    private readonly timetableRepository: Repository<TimetableEntity>,
    @InjectRepository(TimetableStopEntity)
    private readonly timetableStopRepository: Repository<TimetableStopEntity>,
    @InjectRepository(TrainCoachEntity)
    private readonly trainCoachRepository: Repository<TrainCoachEntity>,
    @InjectRepository(FareEntity)
    private readonly fareRepository: Repository<FareEntity>,
    @Inject(UNIT_OF_WORK)
    private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX)
    private readonly outbox: OutboxPort,
    @InjectRepository(DatedTripEntity)
    private readonly datedTripRepository: Repository<DatedTripEntity>,
    private readonly cls: ClsService,
  ) {}

  /** Fire-and-forget so boot is not delayed. Idempotent, so two instances are safe. */
  onApplicationBootstrap(): void {
    if (!tripGenerationEnabled()) {
      this.logger.log('Trip generation disabled by TRIP_GENERATION_ENABLED');
      return;
    }
    this.running = this.loop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.wakeLoop();
    if (this.running) {
      await this.running;
      this.running = null;
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.generateUpcomingTrips();
      } catch (error: unknown) {
        // A Postgres blip must not kill the loop; the next tick retries.
        this.logger.error(
          `Trip generation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (this.stopping) break;
      await this.wait(tripGenerationIntervalMs());
    }
  }

  /**
   * Self-rescheduling, never `setInterval`: overlapping ticks would contend for
   * the same dates. `wakeLoop` stops it without waiting out the interval.
   */
  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wake = null;
        resolve();
      }, ms);
      this.timer.unref?.();
    });
  }

  private wakeLoop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.wake?.();
  }

  /** The ambient trace, so a publish and the trips it generates share one id. */
  private correlationId(): string {
    const ambient = this.cls.isActive()
      ? this.cls.get<string>(CORRELATION_ID_KEY)
      : null;

    return ambient || randomUUID();
  }

  async getPublishedTimetables(timetableId?: string): Promise<TimetableEntity[]> {
    return this.timetableRepository.find({
      where: {
        status: 'published',
        ...(timetableId ? { id: timetableId } : {}),
      },
      relations: {
        train: {
          trainType: true,
        },
      },
    });
  }

  async getTimetableStops(
    timetableId: string,
    manager?: EntityManager,
  ): Promise<TimetableStopEntity[]> {
    const repository =
      manager?.getRepository(TimetableStopEntity) ??
      this.timetableStopRepository;

    return repository.find({
      where: {
        timetable: { id: timetableId },
      },
      relations: {
        station: true,
      },
      order: {
        position: 'ASC',
      },
    });
  }

  isTimetableRunningOnDate(
    timetable: TimetableEntity,
    serviceDate: string,
  ): boolean {
    const date = new Date(`${serviceDate}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    if (serviceDate < timetable.effectiveFrom) {
      return false;
    }

    if (timetable.effectiveUntil && serviceDate > timetable.effectiveUntil) {
      return false;
    }

    return timetable.runningDays.includes(date.getUTCDay());
  }

  async getTrainCoaches(
    trainId: string,
    manager?: EntityManager,
  ): Promise<TrainCoachEntity[]> {
    const repository =
      manager?.getRepository(TrainCoachEntity) ?? this.trainCoachRepository;

    return repository.find({
      where: {
        train: { id: trainId },
      },
      relations: {
        travelClass: true,
        coachLayout: true,
      },
      order: {
        position: 'ASC',
      },
    });
  }

  buildCompositionSnapshot(coaches: TrainCoachEntity[]) {
    return coaches.map((coach) => ({
      position: coach.position,
      coachNumber: coach.coachNumber,
      travelClass: {
        id: coach.travelClass.id,
        nameEn: coach.travelClass.nameEn,
        nameAr: coach.travelClass.nameAr,
      },
      coachLayout: {
        id: coach.coachLayout.id,
        layoutName: coach.coachLayout.layoutName,
        rows: coach.coachLayout.rows,
      },
    }));
  }

  buildTripStops(
    timetableStops: TimetableStopEntity[],
    serviceDate: string,
  ): TripStopDraft[] {
    return timetableStops.map((stop) => {
      const stopDate = addCivilDays(serviceDate, stop.dayOffset);

      return {
        station: stop.station,
        stationId: stop.stationId,
        position: stop.position,
        arrivalAt: stop.arrivalTime
          ? cairoInstantOf(stopDate, stop.arrivalTime)
          : null,
        departureAt: stop.departureTime
          ? cairoInstantOf(stopDate, stop.departureTime)
          : null,
      };
    });
  }

  /** Every fare of one train, in one query. */
  async buildFareIndex(
    trainId: string,
    manager?: EntityManager,
  ): Promise<FareIndex> {
    const repository =
      manager?.getRepository(FareEntity) ?? this.fareRepository;

    const fares = await repository.find({
      where: {
        train: { id: trainId },
      },
      relations: {
        travelClass: true,
      },
    });

    const index: FareIndex = new Map();

    for (const fare of fares) {
      const key = fareKey(
        fare.travelClass.id,
        fare.originStationId,
        fare.destinationStationId,
      );

      const prices = index.get(key) ?? [];
      prices.push({
        effectiveFrom: fare.effectiveFrom,
        amountPiastres: fare.amountPiastres,
      });
      index.set(key, prices);
    }

    // Newest first, so resolving is "the first one that had taken effect".
    for (const prices of index.values()) {
      prices.sort(
        (left, right) =>
          right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
      );
    }

    return index;
  }

  private resolveFare(
    index: FareIndex,
    travelClassId: string,
    originStationId: string,
    destinationStationId: string,
    asOf: Date,
  ): number | null {
    const prices = index.get(
      fareKey(travelClassId, originStationId, destinationStationId),
    );

    const price = prices?.find(
      (candidate) => candidate.effectiveFrom.getTime() <= asOf.getTime(),
    );

    if (!price) {
      return null;
    }

    if (
      !Number.isSafeInteger(price.amountPiastres) ||
      price.amountPiastres <= 0
    ) {
      return null;
    }

    return price.amountPiastres;
  }

  /**
   * Every in-order pair, for every class, must have one positive fare, and a
   * longer segment must never cost less than one it contains. Both are
   * publishing errors, not search-time surprises.
   *
   * Comparing each pair with the pair one stop shorter at either end is enough;
   * containment follows by shrinking one end at a time.
   */
  validateTripFares(
    coaches: TrainCoachEntity[],
    tripStops: TripStopDraft[],
    fares: FareIndex,
  ): void {
    const travelClassIds = [
      ...new Set(coaches.map((coach) => coach.travelClass.id)),
    ];

    if (travelClassIds.length === 0) {
      throw new Error('Train has no travel classes');
    }

    if (tripStops.length < 2) {
      throw new Error('Trip must have at least two stops');
    }

    const problems: string[] = [];

    for (const travelClassId of travelClassIds) {
      const amounts = new Map<string, number>();

      for (let i = 0; i < tripStops.length - 1; i++) {
        const originStop = tripStops[i];

        if (!originStop.departureAt) {
          throw new Error('Origin stop has no departure time');
        }

        for (let j = i + 1; j < tripStops.length; j++) {
          const destinationStop = tripStops[j];

          const amount = this.resolveFare(
            fares,
            travelClassId,
            originStop.stationId,
            destinationStop.stationId,
            originStop.departureAt,
          );

          if (amount === null) {
            problems.push(
              `missing or invalid fare for class ${travelClassId} from ${originStop.stationId} to ${destinationStop.stationId}`,
            );
            continue;
          }

          amounts.set(`${i}|${j}`, amount);
        }
      }

      for (let i = 0; i < tripStops.length - 1; i++) {
        for (let j = i + 1; j < tripStops.length; j++) {
          const amount = amounts.get(`${i}|${j}`);

          if (amount === undefined) {
            continue;
          }

          for (const contained of [`${i}|${j - 1}`, `${i + 1}|${j}`]) {
            const inner = amounts.get(contained);

            if (inner !== undefined && amount < inner) {
              problems.push(
                `fare for class ${travelClassId} from stop ${i} to ${j} (${amount}) is less than the segment it contains (${inner})`,
              );
            }
          }
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(`Invalid fares: ${problems.join('; ')}`);
    }
  }

  /**
   * Sums the same keys the search's capacity SQL does, so the two agree. A
   * repeated seat number would inflate it, so it is refused in the same pass.
   */
  calculateCapacity(coaches: TrainCoachEntity[]): number {
    let capacity = 0;

    for (const coach of coaches) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();

      for (const row of coach.coachLayout.rows) {
        for (const seat of [...row.leftSeats, ...row.rightSeats]) {
          if (seen.has(seat)) duplicates.add(seat);
          seen.add(seat);
          capacity += 1;
        }
      }

      if (duplicates.size > 0) {
        throw new Error(
          `Coach ${coach.coachNumber} repeats seat ${[...duplicates]
            .sort()
            .join(', ')}`,
        );
      }
    }

    if (capacity === 0) {
      throw new Error('Train has no seats');
    }

    return capacity;
  }

  validateTimetableStops(stops: TimetableStopEntity[]): void {
    if (stops.length < 2) {
      throw new Error('Timetable must have at least two stops');
    }

    const firstStop = stops[0];
    const lastStop = stops[stops.length - 1];

    if (firstStop.arrivalTime !== null) {
      throw new Error('First stop must not have arrival time');
    }

    if (!firstStop.departureTime) {
      throw new Error('First stop must have departure time');
    }

    if (!lastStop.arrivalTime) {
      throw new Error('Last stop must have arrival time');
    }

    if (lastStop.departureTime !== null) {
      throw new Error('Last stop must not have departure time');
    }

    for (let i = 1; i < stops.length - 1; i++) {
      if (!stops[i].arrivalTime || !stops[i].departureTime) {
        throw new Error(
          'Intermediate stop must have arrival and departure times',
        );
      }
    }

    for (let i = 1; i < stops.length; i++) {
      if (stops[i].position <= stops[i - 1].position) {
        throw new Error('Timetable stops are not correctly ordered');
      }

      if (stops[i].dayOffset < stops[i - 1].dayOffset) {
        throw new Error('Timetable day offset cannot go backwards');
      }
    }
  }

  validateTripStopTimes(tripStops: TripStopDraft[]): void {
    for (let i = 0; i < tripStops.length; i++) {
      const currentStop = tripStops[i];

      if (
        currentStop.arrivalAt &&
        currentStop.departureAt &&
        currentStop.departureAt.getTime() < currentStop.arrivalAt.getTime()
      ) {
        throw new Error('Departure cannot be before arrival');
      }

      if (i === 0) {
        continue;
      }

      const previousStop = tripStops[i - 1];

      if (!previousStop.departureAt || !currentStop.arrivalAt) {
        throw new Error('Invalid trip stop times');
      }

      if (
        currentStop.arrivalAt.getTime() < previousStop.departureAt.getTime()
      ) {
        throw new Error('Trip stops are not in chronological order');
      }
    }
  }

  /**
   * Validates a timetable the way generation will, without writing anything, so
   * a publish can be refused before it commits.
   */
  async validateTimetableForGeneration(
    timetable: TimetableEntity,
    serviceDate: string,
  ): Promise<void> {
    const stops = await this.getTimetableStops(timetable.id);
    this.validateTimetableStops(stops);

    const coaches = await this.getTrainCoaches(timetable.train.id);
    this.calculateCapacity(coaches);

    const tripStops = this.buildTripStops(stops, serviceDate);
    this.validateTripStopTimes(tripStops);

    const fares = await this.buildFareIndex(timetable.train.id);
    this.validateTripFares(coaches, tripStops, fares);
  }

  /**
   * Validates the first date the timetable actually runs on in the window. A
   * fare gap is the same on every date, so one is enough to refuse a publish.
   */
  async validateTimetableForWindow(timetable: TimetableEntity): Promise<void> {
    const [startDate, endDate] = this.generationWindow();

    for (
      let serviceDate = startDate;
      serviceDate <= endDate;
      serviceDate = addCivilDays(serviceDate, 1)
    ) {
      if (this.isTimetableRunningOnDate(timetable, serviceDate)) {
        await this.validateTimetableForGeneration(timetable, serviceDate);
        return;
      }
    }

    // Nothing runs in the window, but a broken route is still worth refusing.
    this.validateTimetableStops(await this.getTimetableStops(timetable.id));
  }

  async createDatedTrip(
    timetable: TimetableEntity,
    serviceDate: string,
  ): Promise<DatedTripEntity> {
    const existingTrip = await this.findTrip(timetable.train.id, serviceDate);

    if (existingTrip) {
      return existingTrip;
    }

    try {
      return await this.unitOfWork.withTransaction(async (ctx) => {
        const manager = entityManagerOf(ctx);

        const datedTripRepository = manager.getRepository(DatedTripEntity);
        const tripStopRepository = manager.getRepository(TripStopEntity);

        // Inside the transaction: an earlier snapshot could name gone coaches.
        const timetableStops = await this.getTimetableStops(
          timetable.id,
          manager,
        );
        this.validateTimetableStops(timetableStops);

        const coaches = await this.getTrainCoaches(timetable.train.id, manager);
        const capacity = this.calculateCapacity(coaches);

        const tripStops = this.buildTripStops(timetableStops, serviceDate);
        this.validateTripStopTimes(tripStops);

        const fares = await this.buildFareIndex(timetable.train.id, manager);
        this.validateTripFares(coaches, tripStops, fares);

        const compositionSnapshot = this.buildCompositionSnapshot(coaches);
        const occurredAt = new Date();

        const trip = datedTripRepository.create({
          id: randomUUID(),
          train: timetable.train,
          timetable,
          serviceDate,
          timetableVersion: timetable.version,
          compositionSnapshot,
          status: 'published',
          publishedAt: occurredAt,
        });

        const savedTrip = await datedTripRepository.save(trip);

        const stops = tripStops.map((stop) =>
          tripStopRepository.create({
            id: randomUUID(),
            trip: savedTrip,
            station: stop.station,
            stationId: stop.stationId,
            position: stop.position,
            arrivalAt: stop.arrivalAt,
            departureAt: stop.departureAt,
          }),
        );

        await tripStopRepository.save(stops);

        const event = buildTripPublished({
          eventId: randomUUID(),
          correlationId: this.correlationId(),
          occurredAt,
          payload: {
            tripId: savedTrip.id,
            trainId: timetable.train.id,
            trainNumber: timetable.train.trainNumber,
            trainType: {
              id: timetable.train.trainType.id,
              nameEn: timetable.train.trainType.nameEn,
              nameAr: timetable.train.trainType.nameAr,
            },
            serviceDate,
            timetableVersion: timetable.version,
            capacity,
            stops: tripStops.map((stop) => ({
              stationId: stop.stationId,
              position: stop.position,
              arrivalAt: stop.arrivalAt?.toISOString() ?? null,
              departureAt: stop.departureAt?.toISOString() ?? null,
            })),
            coaches: compositionSnapshot,
          },
        });

        await this.outbox.append(ctx, event);

        return savedTrip;
      });
    } catch (error: unknown) {
      // Only the race this is written for: another instance inserted the same
      // (train, service_date) first. Anything else is a real failure.
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.findTrip(timetable.train.id, serviceDate);

      if (!winner) {
        throw error;
      }

      return winner;
    }
  }

  private async findTrip(
    trainId: string,
    serviceDate: string,
  ): Promise<DatedTripEntity | null> {
    return this.datedTripRepository.findOne({
      where: {
        train: { id: trainId },
        serviceDate,
      },
    });
  }

  async generateTripsForDateRange(
    startDate: string,
    endDate: string,
    timetableId?: string,
  ): Promise<void> {
    if (startDate > endDate) {
      throw new Error('Start date cannot be after end date');
    }

    const timetables = await this.getPublishedTimetables(timetableId);

    // One timetable's bad fare must not cost every other timetable its window.
    for (const timetable of timetables) {
      try {
        await this.generateTimetableTrips(timetable, startDate, endDate);
      } catch (error: unknown) {
        this.logger.error(
          `Trip generation failed for timetable ${timetable.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async generateTimetableTrips(
    timetable: TimetableEntity,
    startDate: string,
    endDate: string,
  ): Promise<void> {
    // ISO dates compare lexicographically, so a civil date needs no date type.
    for (
      let serviceDate = startDate;
      serviceDate <= endDate;
      serviceDate = addCivilDays(serviceDate, 1)
    ) {
      if (!this.isTimetableRunningOnDate(timetable, serviceDate)) {
        continue;
      }

      await this.createDatedTrip(timetable, serviceDate);
    }
  }

  /**
   * Always from today, never "yesterday's end plus one": a job that was down
   * for three days still fills the gap it left.
   */
  private generationWindow(): [string, string] {
    const startDate = cairoToday(new Date());

    return [
      startDate,
      addCivilDays(startDate, BOOKING_WINDOW_DAYS + GENERATION_MARGIN_DAYS - 1),
    ];
  }

  async generateUpcomingTrips(timetableId?: string): Promise<void> {
    const [startDate, endDate] = this.generationWindow();

    await this.generateTripsForDateRange(startDate, endDate, timetableId);
  }

  async withdrawDatedTrip(tripId: string): Promise<DatedTripEntity> {
    return this.unitOfWork.withTransaction(async (ctx) => {
      const manager = entityManagerOf(ctx);

      const repository = manager.getRepository(DatedTripEntity);

      const trip = await repository.findOne({
        where: { id: tripId },
        lock: {
          mode: 'pessimistic_write',
        },
      });

      if (!trip) {
        throw new NotFoundException('Dated trip not found');
      }

      if (trip.status === 'withdrawn') {
        return trip;
      }

      const occurredAt = new Date();

      trip.status = 'withdrawn';

      const savedTrip = await repository.save(trip);

      const event = buildTripWithdrawn({
        eventId: randomUUID(),
        correlationId: this.correlationId(),
        occurredAt,
        tripId: savedTrip.id,
      });

      await this.outbox.append(ctx, event);

      return savedTrip;
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };

  return (
    candidate.code === UNIQUE_VIOLATION ||
    candidate.driverError?.code === UNIQUE_VIOLATION
  );
}
