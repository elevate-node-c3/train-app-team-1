import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import * as amqp from 'amqplib';
import { DataSource } from 'typeorm';
import {
  AllocationOutcome,
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_HELD_EVENT_TYPE,
  type HoldEventLegV1,
  type HoldLifecycleEvent,
  type HoldPassengerLegIdentityInput,
} from '@app/contracts';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { MigrationRunnerService } from '@app/common/persistence/migration-runner.service.js';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import {
  entityManagerOf,
  TypeOrmUnitOfWork,
} from '@app/common/persistence/typeorm-unit-of-work.js';
import {
  AmqpClientService,
  EVENTS_EXCHANGE,
  EventPublisherService,
  OutboxRelayService,
  TypeOrmOutboxRepository,
  parseEventEnvelope,
} from '@app/messaging';
import { HoldCoreRepository } from '../../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { HoldCoreService } from '../../../apps/inventory/src/modules/seat-hold/hold-core.service.js';
import { HoldExpiryWorker } from '../../../apps/inventory/src/modules/seat-hold/hold-expiry.worker.js';
import { buildHoldEvent } from '../../../apps/inventory/src/modules/seat-hold/hold-events.factory.js';
import { INVENTORY_DATABASE_URL } from './inventory-database.js';

export const HOUR_MS = 3_600_000;
const HOLD_TTL_MS = 900_000;
const TRAVEL_CLASS = randomUUID();
const STATIONS = [randomUUID(), randomUUID(), randomUUID()];

/** Refuse developer ports before any fixture can truncate or create a queue. */
export function isolatedHoldEndpoints(): { database: string; rabbit: string } {
  const database = new URL(INVENTORY_DATABASE_URL);
  const rabbit = new URL(process.env.HOLDS_TEST_RABBITMQ_URL ?? '');
  // Local compose only: these fixtures truncate, so a remote or shared target
  // must never be reachable from here. The ports come from the override.
  const postgresPort = process.env.POSTGRES_HOST_PORT?.trim() || '15432';
  const amqpPort = process.env.AMQP_HOST_PORT?.trim() || '15673';
  if (
    database.hostname !== '127.0.0.1' ||
    database.port !== postgresPort ||
    database.pathname !== '/inventory' ||
    database.username !== 'inventory'
  ) {
    throw new Error(
      `TA-70 fixtures require the inventory role/database on 127.0.0.1:${postgresPort}`,
    );
  }
  if (
    rabbit.protocol !== 'amqp:' ||
    rabbit.hostname !== '127.0.0.1' ||
    rabbit.port !== amqpPort
  ) {
    throw new Error(
      `TA-70 fixtures require the local compose RabbitMQ on 127.0.0.1:${amqpPort}`,
    );
  }
  return { database: database.href, rabbit: rabbit.href };
}

/** Each context owns real production services, its PG pool, and its AMQP connection. */
export async function inventoryExpiryInstance(
  observer: DataSource,
  label: string,
  start = true,
) {
  const options = observer.options;
  if (options.type !== 'postgres') throw new Error('TA-70 requires PostgreSQL');
  const source = new DataSource({
    ...options,
    extra: { ...options.extra, max: 4, application_name: `holds-${label}` },
  });
  const module = await Test.createTestingModule({
    imports: [ClsModule.forRoot()],
    providers: [
      {
        provide: DataSourceInitializer,
        useFactory: () => new DataSourceInitializer(source),
      },
      {
        provide: SchemaReadinessGate,
        useFactory: () => new SchemaReadinessGate(),
      },
      {
        provide: MigrationRunnerService,
        inject: [DataSourceInitializer, SchemaReadinessGate],
        useFactory: (
          initializer: DataSourceInitializer,
          schema: SchemaReadinessGate,
        ) => new MigrationRunnerService(initializer, schema),
      },
      {
        provide: TypeOrmUnitOfWork,
        inject: [DataSourceInitializer],
        useFactory: (initializer: DataSourceInitializer) =>
          new TypeOrmUnitOfWork(initializer),
      },
      {
        provide: TypeOrmOutboxRepository,
        inject: [DataSourceInitializer],
        useFactory: (initializer: DataSourceInitializer) =>
          new TypeOrmOutboxRepository(initializer),
      },
      {
        provide: HoldCoreRepository,
        useFactory: () => new HoldCoreRepository(),
      },
      {
        provide: HoldCoreService,
        inject: [
          HoldCoreRepository,
          TypeOrmUnitOfWork,
          TypeOrmOutboxRepository,
        ],
        useFactory: (
          repository: HoldCoreRepository,
          unit: TypeOrmUnitOfWork,
          outbox: TypeOrmOutboxRepository,
        ) => new HoldCoreService(repository, unit, outbox),
      },
      { provide: AmqpClientService, useFactory: () => new AmqpClientService() },
      {
        provide: EventPublisherService,
        inject: [AmqpClientService],
        useFactory: (client: AmqpClientService) =>
          new EventPublisherService(client),
      },
      {
        provide: OutboxRelayService,
        inject: [
          TypeOrmUnitOfWork,
          TypeOrmOutboxRepository,
          EventPublisherService,
          ClsService,
          SchemaReadinessGate,
        ],
        useFactory: (
          unit: TypeOrmUnitOfWork,
          outbox: TypeOrmOutboxRepository,
          publisher: EventPublisherService,
          cls: ClsService,
          schema: SchemaReadinessGate,
        ) => new OutboxRelayService(unit, outbox, publisher, cls, schema),
      },
      {
        provide: HoldExpiryWorker,
        inject: [HoldCoreService, SchemaReadinessGate, MigrationRunnerService],
        useFactory: (
          holds: HoldCoreService,
          schema: SchemaReadinessGate,
          migrations: MigrationRunnerService,
        ) => new HoldExpiryWorker(holds, schema, migrations),
      },
    ],
  }).compile();
  let closed = false;
  const instance = {
    source,
    worker: module.get(HoldExpiryWorker),
    relay: module.get(OutboxRelayService),
    outbox: module.get(TypeOrmOutboxRepository),
    publisher: module.get(EventPublisherService),
    amqp: module.get(AmqpClientService),
    migrations: module.get(MigrationRunnerService),
    start: async () => {
      await module.init();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await module.close();
      if (source.isInitialized) await source.destroy();
    },
  };
  if (start) await instance.start();
  return instance;
}

export type InventoryExpiryInstance = Awaited<
  ReturnType<typeof inventoryExpiryInstance>
>;

interface SeedGroup {
  id: string;
  ownerId: string;
  bookingKey: string;
  fingerprint: string;
  legs: HoldEventLegV1[];
  passengers: {
    passengerRef: string;
    slot: number;
    identities: HoldPassengerLegIdentityInput[];
  }[];
}

export interface SeededHoldGroups {
  deadline: Date;
  groups: SeedGroup[];
  heldEventIds: string[];
  expectedLegs: number;
  expectedAssignments: number;
  seedMs: number;
}

/** Bulk seed receipts, not expiry logic; all FKs/exclusions stay enabled. */
export async function seedHoldGroups(
  source: DataSource,
  count: number,
  dueInMs = 10_000,
): Promise<SeededHoldGroups> {
  isolatedHoldEndpoints();
  if (!Number.isInteger(count) || count < 1 || count > 10_000)
    throw new Error('Invalid TA-70 fixture size');
  const began = performance.now();
  const trips = Array.from(
    { length: Math.ceil(count / 100) * 2 },
    (_, index) => ({
      id: randomUUID(),
      trainId: randomUUID(),
      index,
      reverse: index % 2 === 1,
    }),
  );
  const groups: SeedGroup[] = Array.from({ length: count }, (_, index) => {
    const id = randomUUID();
    const multi = index % 10 === 0;
    const wantedTrips = trips.slice(
      Math.floor(index / 100) * 2,
      Math.floor(index / 100) * 2 + (multi ? 2 : 1),
    );
    const legs = wantedTrips.map((trip): HoldEventLegV1 => ({
      tripId: trip.id,
      travelClassId: TRAVEL_CLASS,
      originStationId: STATIONS[trip.reverse ? 2 : 0],
      destinationStationId: STATIONS[trip.reverse ? 0 : 2],
      originPosition: 0,
      destinationPosition: 2,
      outcome: AllocationOutcome.SAME_COACH,
    }));
    const passengers = Array.from(
      { length: multi ? 2 : 1 },
      (_, passengerIndex) => {
        const passengerRef = randomUUID();
        return {
          passengerRef,
          slot: (index % 100) * 2 + passengerIndex + 1,
          identities: legs.map((leg) => ({
            tripId: leg.tripId,
            passengerKeyVersion: 1,
            passengerToken: createHash('sha256')
              .update(`holds:${id}:${passengerRef}:${leg.tripId}`)
              .digest('hex'),
          })),
        };
      },
    );
    return {
      id,
      ownerId: randomUUID(),
      bookingKey: randomUUID(),
      fingerprint: createHash('sha256').update(`fixture:${id}`).digest('hex'),
      legs,
      passengers,
    };
  });
  const initializer = new DataSourceInitializer(source);
  const outbox = new TypeOrmOutboxRepository(initializer);
  let deadline = new Date(0);
  let heldEventIds: string[] = [];

  await new TypeOrmUnitOfWork(initializer).withTransaction(async (ctx) => {
    const manager = entityManagerOf(ctx);
    await manager.query(`SET LOCAL statement_timeout = '90s'`);
    const [clock]: { now: Date }[] = await manager.query(
      'SELECT clock_timestamp() AS now',
    );
    await manager.query(
      `CREATE TEMP TABLE holds_trip_seed ON COMMIT DROP AS
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(id uuid, "trainId" uuid, index integer, reverse boolean)`,
      [JSON.stringify(trips)],
    );
    await manager.query(
      `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
      SELECT id, 'on_sale', 1, "trainId", 1000 + index, $1::timestamptz::date FROM holds_trip_seed`,
      [clock.now],
    );
    await manager.query(
      `INSERT INTO trip_stop (trip_id, position, station_id, arrival_at, departure_at)
      SELECT t.id, p.position,
        CASE p.position WHEN 0 THEN CASE WHEN t.reverse THEN $4::uuid ELSE $2::uuid END
                        WHEN 1 THEN $3::uuid ELSE CASE WHEN t.reverse THEN $2::uuid ELSE $4::uuid END END,
        CASE WHEN p.position = 0 THEN NULL ELSE $1::timestamptz + interval '40 minutes' + p.position * interval '10 minutes' + CASE WHEN t.reverse THEN interval '2 hours' ELSE interval '0' END END,
        CASE WHEN p.position = 2 THEN NULL ELSE $1::timestamptz + interval '40 minutes' + p.position * interval '10 minutes' + CASE WHEN t.reverse THEN interval '2 hours' ELSE interval '0' END END
      FROM holds_trip_seed t CROSS JOIN (VALUES (0), (1), (2)) p(position)`,
      [clock.now, ...STATIONS],
    );
    await manager.query(
      `INSERT INTO trip_coach (id, trip_id, coach_number, position, travel_class_id, travel_class_name_en, travel_class_name_ar)
      SELECT gen_random_uuid(), t.id, c.number, c.number - 1, $1, 'HOLDS Economy', 'HOLDS Economy'
      FROM holds_trip_seed t CROSS JOIN generate_series(1, 3) c(number)`,
      [TRAVEL_CLASS],
    );
    await manager.query(`INSERT INTO trip_seat (id, trip_id, trip_coach_id, seat_number, travel_class_id, row_number, side, seat_index_in_side)
      SELECT gen_random_uuid(), c.trip_id, c.id, s.number::text, c.travel_class_id, (s.number + 1) / 2,
        CASE WHEN s.number % 2 = 1 THEN 'left' ELSE 'right' END, 0
      FROM trip_coach c CROSS JOIN LATERAL generate_series(1, CASE WHEN c.coach_number = 3 THEN 40 ELSE 80 END) s(number)`);
    await manager.query(
      `CREATE TEMP TABLE holds_hold_seed ON COMMIT DROP AS
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS h(id uuid, "ownerId" uuid, "bookingKey" text, fingerprint text, legs jsonb, passengers jsonb)`,
      [JSON.stringify(groups)],
    );
    await manager.query(
      `INSERT INTO seat_hold_owner_guard (owner_id, created_at) SELECT "ownerId", $1 FROM holds_hold_seed`,
      [clock.now],
    );
    await manager.query(
      `INSERT INTO seat_hold_group (id, booking_key, owner_id, request_fingerprint, state, version, extension_used, expires_at, created_at, updated_at)
      SELECT id, "bookingKey", "ownerId", fingerprint, 'held', 1, false, $1::timestamptz + interval '15 minutes', $1, $1 FROM holds_hold_seed`,
      [clock.now],
    );
    await manager.query(
      `INSERT INTO seat_hold_leg (id, hold_id, trip_id, travel_class_id, origin_station_id, destination_station_id, origin_position, destination_position, segment, outcome, created_at)
      SELECT gen_random_uuid(), h.id, l."tripId", l."travelClassId", l."originStationId", l."destinationStationId", l."originPosition", l."destinationPosition", int4range(0, 2, '[)'), l.outcome, $1
      FROM holds_hold_seed h CROSS JOIN LATERAL jsonb_to_recordset(h.legs) AS l("tripId" uuid, "travelClassId" uuid, "originStationId" uuid, "destinationStationId" uuid, "originPosition" integer, "destinationPosition" integer, outcome text)`,
      [clock.now],
    );
    await manager.query(
      `INSERT INTO seat_hold_passenger (id, hold_id, trip_id, passenger_ref, passenger_token, passenger_key_version, created_at)
      SELECT gen_random_uuid(), h.id, i."tripId", p."passengerRef", i."passengerToken", i."passengerKeyVersion", $1
      FROM holds_hold_seed h
      CROSS JOIN LATERAL jsonb_to_recordset(h.passengers) AS p("passengerRef" text, identities jsonb)
      CROSS JOIN LATERAL jsonb_to_recordset(p.identities) AS i("tripId" uuid, "passengerToken" text, "passengerKeyVersion" integer)`,
      [clock.now],
    );
    await manager.query(
      `CREATE TEMP TABLE holds_assignment_seed ON COMMIT DROP AS
       SELECT h.id AS hold_id, p."passengerRef" AS passenger_ref,
         l."tripId" AS trip_id, l."travelClassId" AS travel_class_id,
         l."originStationId" AS origin_station_id, l."destinationStationId" AS destination_station_id,
         l."originPosition" AS origin_position, l."destinationPosition" AS destination_position, l.outcome,
         (p.slot - 1) / 80 + 1 AS coach_number, ((p.slot - 1) % 80 + 1)::text AS seat_number
       FROM holds_hold_seed h
       CROSS JOIN LATERAL jsonb_to_recordset(h.passengers) AS p("passengerRef" text, slot integer)
       CROSS JOIN LATERAL jsonb_to_recordset(h.legs) AS l("tripId" uuid, "travelClassId" uuid, "originStationId" uuid, "destinationStationId" uuid, "originPosition" integer, "destinationPosition" integer, outcome text)`,
    );
    // JSON recordsets have generic row estimates. Real statistics avoid an
    // enormous nested-loop plan after small tests have truncated these tables.
    await manager.query('ANALYZE holds_assignment_seed');
    await manager.query('ANALYZE trip_coach');
    await manager.query('ANALYZE trip_seat');
    await manager.query(
      `INSERT INTO seat_hold_assignment (id, hold_id, passenger_ref, passenger_key_version, trip_id, trip_seat_id, travel_class_id, coach_number, seat_number, row_number, outcome, origin_station_id, destination_station_id, origin_position, destination_position, segment, created_at)
       SELECT gen_random_uuid(), a.hold_id, a.passenger_ref, 1, a.trip_id, s.id, a.travel_class_id, c.coach_number, s.seat_number, s.row_number, a.outcome,
         a.origin_station_id, a.destination_station_id, a.origin_position, a.destination_position, int4range(0, 2, '[)'), $1
       FROM holds_assignment_seed a
       JOIN trip_coach c ON c.trip_id = a.trip_id AND c.coach_number = a.coach_number
       JOIN trip_seat s ON s.trip_coach_id = c.id AND s.seat_number = a.seat_number`,
      [clock.now],
    );
    await manager.query('ANALYZE seat_hold_assignment');
    await manager.query('ANALYZE seat_hold_group');
    await manager.query('ANALYZE seat_hold_passenger');
    await manager.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at, reference_id, hold_id, owner_id, passenger_ref, passenger_token, passenger_key_version, created_at, updated_at)
      SELECT gen_random_uuid(), a.trip_seat_id, a.trip_id, a.segment, 'held', h.expires_at, h.id, h.id, h.owner_id, a.passenger_ref, p.passenger_token, p.passenger_key_version, $1, $1
      FROM seat_hold_assignment a JOIN seat_hold_group h ON h.id = a.hold_id
      JOIN seat_hold_passenger p ON p.hold_id = a.hold_id AND p.trip_id = a.trip_id AND p.passenger_ref = a.passenger_ref`,
      [clock.now],
    );
  });

  // Commit the expensive fixture first. Only this small final transaction arms
  // the common deadline and its held events; none has been published beforehand.
  await new TypeOrmUnitOfWork(initializer).withTransaction(async (ctx) => {
    const manager = entityManagerOf(ctx);
    await manager.query(`SET LOCAL statement_timeout = '90s'`);
    const [armed]: { now: Date }[] = await manager.query(
      'SELECT clock_timestamp() AS now',
    );
    deadline = new Date(armed.now.getTime() + dueInMs);
    const issuedAt = new Date(deadline.getTime() - HOLD_TTL_MS);
    await manager.query(
      'UPDATE seat_hold_group SET expires_at = $1, created_at = $2, updated_at = $2',
      [deadline, issuedAt],
    );
    await manager.query(
      'UPDATE seat_occupation SET hold_expires_at = $1, created_at = $2, updated_at = $2',
      [deadline, issuedAt],
    );
    const events = groups.map((group) =>
      buildHoldEvent({
        eventId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: issuedAt,
        payload: {
          holdId: group.id,
          bookingKey: group.bookingKey,
          ownerId: group.ownerId,
          aggregateVersion: 1,
          state: 'HELD',
          allocationOutcome: AllocationOutcome.SAME_COACH,
          legs: group.legs,
          expiresAt: deadline.toISOString(),
          extensionUsed: false,
          reason: 'held',
        },
      }),
    );
    heldEventIds = events.map((event) => event.id);
    await outbox.appendBatch(ctx, events);
  });
  return {
    deadline,
    groups,
    heldEventIds,
    expectedLegs: groups.reduce((sum, group) => sum + group.legs.length, 0),
    expectedAssignments: groups.reduce(
      (sum, group) => sum + group.legs.length * group.passengers.length,
      0,
    ),
    seedMs: performance.now() - began,
  };
}

export interface ExpirySnapshot {
  now: Date;
  groups: number;
  held: number;
  expired: number;
  versionTwo: number;
  occupations: number;
  unreleased: number;
  heldEvents: number;
  expiredEvents: number;
  publishedHeld: number;
  publishedExpired: number;
  failedEvents: number;
  maxReleaseMs: number | null;
  maxPublishedMs: number | null;
}

/** The snapshot sees committed rows; a separate checkpoint follows broker capture. */
export async function expirySnapshot(
  source: DataSource,
): Promise<ExpirySnapshot> {
  const [snapshot]: ExpirySnapshot[] = await source.query(`WITH h AS (
      SELECT count(*)::integer AS groups, count(*) FILTER (WHERE state = 'held')::integer AS held,
        count(*) FILTER (WHERE state = 'expired')::integer AS expired,
        count(*) FILTER (WHERE version = 2)::integer AS "versionTwo",
        (max(extract(epoch FROM released_at - expires_at)) * 1000)::double precision AS "maxReleaseMs"
      FROM seat_hold_group
    ), o AS (
      SELECT count(*)::integer AS occupations, count(*) FILTER (WHERE released_at IS NULL)::integer AS unreleased FROM seat_occupation
    ), e AS (
      SELECT count(*) FILTER (WHERE event_type = '${HOLD_HELD_EVENT_TYPE}')::integer AS "heldEvents",
        count(*) FILTER (WHERE event_type = '${HOLD_EXPIRED_EVENT_TYPE}')::integer AS "expiredEvents",
        count(*) FILTER (WHERE event_type = '${HOLD_HELD_EVENT_TYPE}' AND published_at IS NOT NULL)::integer AS "publishedHeld",
        count(*) FILTER (WHERE event_type = '${HOLD_EXPIRED_EVENT_TYPE}' AND published_at IS NOT NULL)::integer AS "publishedExpired",
        count(*) FILTER (WHERE attempt_count > 0)::integer AS "failedEvents",
        (max(extract(epoch FROM published_at - (payload->>'expiresAt')::timestamptz)) FILTER (WHERE event_type = '${HOLD_EXPIRED_EVENT_TYPE}') * 1000)::double precision AS "maxPublishedMs"
      FROM outbox_event
    ) SELECT clock_timestamp() AS now, h.*, o.*, e.* FROM h CROSS JOIN o CROSS JOIN e`);
  return snapshot;
}

export async function waitForSnapshot(
  source: DataSource,
  ready: (snapshot: ExpirySnapshot) => boolean,
  timeoutMs: number,
): Promise<ExpirySnapshot> {
  const end = performance.now() + timeoutMs;
  let snapshot: ExpirySnapshot;
  do {
    snapshot = await expirySnapshot(source);
    if (ready(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (performance.now() < end);
  throw new Error(`TA-70 observation timed out: ${JSON.stringify(snapshot)}`);
}

export interface CapturedHoldEvent {
  event: HoldLifecycleEvent;
  firstAt: number;
  deliveries: number;
}

/** This owned quorum queue proves a durable route, not all consumer effects. */
export async function holdEventCapture(previousQueue?: string) {
  const { rabbit } = isolatedHoldEndpoints();
  const queue = previousQueue ?? `${CAPTURE_QUEUE_PREFIX}${randomUUID()}`;
  if (!/^holds\.expiry\.capture\.[0-9a-f-]{36}$/.test(queue))
    throw new Error('Only an owned TA-70 capture queue may be resumed');
  await removeStaleExpiryCaptures(queue);
  const connection = await amqp.connect(rabbit, { timeout: 5_000 });
  const channel = await connection.createChannel();
  const records = new Map<string, CapturedHoldEvent>();
  const errors: string[] = [];
  connection.on('error', (error: Error) => {
    errors.push(error.message);
  });
  channel.on('error', (error: Error) => {
    errors.push(error.message);
  });
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', {
    durable: true,
    autoDelete: false,
  });
  await channel.assertQueue(queue, {
    durable: true,
    autoDelete: false,
    arguments: { 'x-queue-type': 'quorum' },
  });
  for (const type of [HOLD_HELD_EVENT_TYPE, HOLD_EXPIRED_EVENT_TYPE])
    await channel.bindQueue(queue, EVENTS_EXCHANGE, type);
  await channel.prefetch(1_024);
  const consumer = await channel.consume(
    queue,
    (message) => {
      if (!message) return;
      try {
        const event = parseEventEnvelope(message.content, {
          type: message.fields.routingKey,
          version: 1,
        }) as HoldLifecycleEvent;
        if (
          message.properties.messageId !== event.id ||
          message.properties.deliveryMode !== 2
        )
          throw new Error('Non-persistent or mismatched event ID');
        const existing = records.get(event.id);
        if (existing) existing.deliveries += 1;
        else
          records.set(event.id, {
            event,
            firstAt: performance.now(),
            deliveries: 1,
          });
        channel.ack(message);
      } catch (error: unknown) {
        errors.push(
          error instanceof Error ? error.message : 'Invalid captured envelope',
        );
        channel.nack(message, false, false);
      }
    },
    { noAck: false },
  );
  return {
    queue,
    records,
    errors,
    byType: (type: string) =>
      [...records.values()].filter((record) => record.event.type === type),
    unbindExpiry: async () => {
      await channel.unbindQueue(
        queue,
        EVENTS_EXCHANGE,
        HOLD_EXPIRED_EVENT_TYPE,
      );
    },
    bindExpiry: async () => {
      await channel.bindQueue(queue, EVENTS_EXCHANGE, HOLD_EXPIRED_EVENT_TYPE);
    },
    disconnect: async () => {
      // Leave the durable queue and its unconsumed messages on the broker.
      await channel.cancel(consumer.consumerTag);
      await channel.close();
      await connection.close();
    },
    close: async () => {
      await channel.cancel(consumer.consumerTag);
      await channel.deleteQueue(queue);
      await channel.close();
      await connection.close();
    },
  };
}

export type HoldEventCapture = Awaited<ReturnType<typeof holdEventCapture>>;

/** The management UI compose publishes beside the AMQP port. */
function managementUrl(path: string): string {
  const port = process.env.RABBITMQ_MANAGEMENT_PORT?.trim() || '15672';
  return `http://127.0.0.1:${port}/api/${path}`;
}

/** The same broker credentials the AMQP URL carries. */
function managementAuthorization(): string {
  const url = new URL(isolatedHoldEndpoints().rabbit);
  const credentials = `${url.username}:${url.password}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

export async function rabbitManagement<T>(path: string): Promise<T> {
  const response = await fetch(managementUrl(path), {
    headers: { Authorization: managementAuthorization() },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Isolated RabbitMQ management returned ${response.status}`);
  return response.json() as Promise<T>;
}

/** The prefix every capture queue this fixture owns is named with. */
const CAPTURE_QUEUE_PREFIX = 'holds.expiry.capture.';

/**
 * Delete capture queues left by an earlier run.
 *
 * The tier shares the development broker, so a run that was interrupted leaves
 * its queue bound to the expiry route, and the next run's isolation assertion
 * sees a binding it did not make. Only this fixture's own queues are removed,
 * never the one it is about to use.
 */
export async function removeStaleExpiryCaptures(keep?: string): Promise<string[]> {
  const queues = await rabbitManagement<{ name: string }[]>('queues/%2F');
  const stale = queues
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(CAPTURE_QUEUE_PREFIX) && name !== keep);

  for (const name of stale) {
    const response = await fetch(managementUrl(`queues/%2F/${name}`), {
      method: 'DELETE',
      headers: { Authorization: managementAuthorization() },
      signal: AbortSignal.timeout(5_000),
    });
    // 404 means another run removed it first, which is the outcome we want.
    if (!response.ok && response.status !== 404)
      throw new Error(`Could not delete ${name}: ${response.status}`);
  }

  return stale;
}

export async function assertNoExpiryBinding(): Promise<void> {
  const bindings =
    await rabbitManagement<
      { source: string; destination: string; routing_key: string }[]
    >('bindings/%2F');
  const matches = (binding: string[], routing: string[]): boolean => {
    if (binding.length === 0) return routing.length === 0;
    if (binding[0] === '#')
      return (
        matches(binding.slice(1), routing) ||
        (routing.length > 0 && matches(binding, routing.slice(1)))
      );
    return (
      routing.length > 0 &&
      (binding[0] === '*' || binding[0] === routing[0]) &&
      matches(binding.slice(1), routing.slice(1))
    );
  };
  const routes = bindings.filter(
    (binding) =>
      binding.source === EVENTS_EXCHANGE &&
      matches(
        binding.routing_key.split('.'),
        HOLD_EXPIRED_EVENT_TYPE.split('.'),
      ),
  );
  if (routes.length > 0)
    throw new Error(
      `Missing-binding test is not isolated: ${routes.map((route) => route.destination).join(', ')}`,
    );
}

/** A real SQL exception rolls back the first post-confirm publication mark. */
export async function failFirstExpiryMark(
  source: DataSource,
): Promise<() => Promise<void>> {
  await source.query('CREATE SEQUENCE holds_fixture_mark_attempt');
  await source.query(
    'CREATE TABLE holds_fixture_mark_audit (event_id uuid, transaction_started_at timestamptz, published_at timestamptz, observed_at timestamptz)',
  );
  await source.query(`CREATE FUNCTION holds_fixture_fail_mark() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type = '${HOLD_EXPIRED_EVENT_TYPE}' AND NEW.published_at IS NOT NULL AND OLD.published_at IS NULL THEN
        IF nextval('holds_fixture_mark_attempt') = 1 THEN
          RAISE EXCEPTION 'HOLDS injected post-confirm database mark failure';
        END IF;
        INSERT INTO holds_fixture_mark_audit VALUES (NEW.id, transaction_timestamp(), NEW.published_at, clock_timestamp());
      END IF;
      RETURN NEW;
    END $$`);
  await source.query(
    'CREATE TRIGGER holds_fixture_fail_mark BEFORE UPDATE ON outbox_event FOR EACH ROW EXECUTE FUNCTION holds_fixture_fail_mark()',
  );
  return async () => {
    await source.query(
      'DROP TRIGGER IF EXISTS holds_fixture_fail_mark ON outbox_event',
    );
    await source.query('DROP FUNCTION IF EXISTS holds_fixture_fail_mark()');
    await source.query('DROP TABLE IF EXISTS holds_fixture_mark_audit');
    await source.query('DROP SEQUENCE IF EXISTS holds_fixture_mark_attempt');
  };
}
