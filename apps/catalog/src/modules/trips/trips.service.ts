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
  cairoToday,
} from '@app/contracts';
import {
  tripGenerationEnabled,
  tripGenerationIntervalMs,
} from '../../config/trip-generation-settings.js';
import {
  computeCapacity,
  validateCapacityIssues,
  validateFareRules,
  validateStopsChronology,
  validateStopsStructure,
  type TimetableStopDraftInput,
} from '../operations/timetable-publish.validator.js';
import {
  isEffectiveVersionOn,
  isWithinEffectiveRange,
} from '../operations/timetable-version.service.js';

import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import { FareEntity } from '../fares/entities/fare.entity.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import {
  fareKey,
  resolveStopTimes,
  type FareIndex,
  type TripStopDraft,
} from './trip-generation.types.js';
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

  /**
   * Every published row, which since TA-20 is not the same as every *live*
   * version: a republish adds version N+1 and leaves its predecessor in place,
   * bounded. Callers must resolve which of a train's rows owns a given service
   * date -- `generateTripsForDateRange` does, via `isEffectiveVersionOn`.
   */
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

  /**
   * The effective range is not read here: `isWithinEffectiveRange` owns that
   * one reading, so this and version resolution cannot drift apart over what
   * `effective_until` means. What is left is this method's own question --
   * whether the timetable runs on that weekday.
   */
  isTimetableRunningOnDate(
    timetable: TimetableEntity,
    serviceDate: string,
  ): boolean {
    const date = new Date(`${serviceDate}T00:00:00.000Z`);

    if (Number.isNaN(date.getTime())) {
      return false;
    }

    if (!isWithinEffectiveRange(timetable, serviceDate)) {
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
    return timetableStops.map((stop) => ({
      station: stop.station,
      stationId: stop.stationId,
      position: stop.position,
      ...resolveStopTimes(
        serviceDate,
        stop.dayOffset,
        stop.arrivalTime,
        stop.departureTime,
      ),
    }));
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

  /**
   * Every in-order pair, for every class, must have one positive fare, and a
   * longer segment must never cost less than one it contains. Both are
   * publishing errors, not search-time surprises. The rules themselves live
   * in the publish validator, so generation and publish can never disagree
   * on what counts as a valid fare table.
   */
  validateTripFares(
    coaches: TrainCoachEntity[],
    tripStops: TripStopDraft[],
    fares: FareIndex,
  ): void {
    const issues = validateFareRules(coaches, tripStops, fares);

    if (issues.length > 0) {
      throw new Error(
        `Invalid fares: ${issues.map((issue) => issue.issue).join('; ')}`,
      );
    }
  }

  /**
   * Sums the same keys the search's capacity SQL does, so the two agree. A
   * repeated seat number would inflate it, so it is refused in the same pass.
   * No catalog of coach layouts is available here, so every layout this train
   * actually carries counts as known.
   */
  calculateCapacity(coaches: TrainCoachEntity[]): number {
    const knownCoachLayoutIds = new Set(
      coaches.map((coach) => coach.coachLayout.id),
    );
    const issues = validateCapacityIssues(coaches, knownCoachLayoutIds);

    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.issue).join('; '));
    }

    return computeCapacity(coaches);
  }

  /**
   * No station catalog is available here either, so every station named by
   * the timetable itself counts as known -- this call only checks the
   * route's shape, not whether the stations are real.
   */
  validateTimetableStops(stops: TimetableStopEntity[]): void {
    const draftStops: TimetableStopDraftInput[] = stops.map((stop) => ({
      stationId: stop.stationId,
      position: stop.position,
      dayOffset: stop.dayOffset,
      arrivalTime: stop.arrivalTime,
      departureTime: stop.departureTime,
    }));
    const knownStationIds = new Set(draftStops.map((stop) => stop.stationId));
    const issues = validateStopsStructure(draftStops, knownStationIds);

    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.issue).join('; '));
    }
  }

  validateTripStopTimes(tripStops: TripStopDraft[]): void {
    const issues = validateStopsChronology(tripStops);

    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.issue).join('; '));
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

    // Always every published row, never only the one asked for: a single
    // timetable still has to be told apart from its own train's other
    // versions, and that cannot be done from a row in isolation.
    const published = await this.getPublishedTimetables();
    const versionsByTrain = groupByTrain(published);

    const timetables = timetableId
      ? published.filter((timetable) => timetable.id === timetableId)
      : published;

    // One timetable's bad fare must not cost every other timetable its window.
    for (const timetable of timetables) {
      try {
        await this.generateTimetableTrips(
          timetable,
          startDate,
          endDate,
          versionsByTrain.get(timetable.train.id) ?? [timetable],
        );
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
    trainVersions: TimetableEntity[],
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

      // The date belongs to exactly one of the train's published versions.
      // Without this, two versions whose ranges overlap would each produce the
      // same dated trip, and the (train, service_date) unique constraint would
      // report the second as "already exists" rather than as the error it is.
      if (!isEffectiveVersionOn(timetable, trainVersions, serviceDate)) {
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

/** Published rows per train, so a date can be resolved without a query each. */
function groupByTrain(
  timetables: TimetableEntity[],
): Map<string, TimetableEntity[]> {
  const byTrain = new Map<string, TimetableEntity[]>();

  for (const timetable of timetables) {
    const existing = byTrain.get(timetable.train.id);

    if (existing) {
      existing.push(timetable);
    } else {
      byTrain.set(timetable.train.id, [timetable]);
    }
  }

  return byTrain;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };

  return (
    candidate.code === UNIQUE_VIOLATION ||
    candidate.driverError?.code === UNIQUE_VIOLATION
  );
}
