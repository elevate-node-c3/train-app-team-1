import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';

import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import {
  TypeOrmUnitOfWork,
  entityManagerOf,
} from '@app/common/persistence/typeorm-unit-of-work.js';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';
import {
  AmqpClientService,
  EventConsumerService,
  EventFailureRouter,
  EventPublisherService,
  MessageRepublisher,
  OutboxRelayService,
  TypeOrmOutboxRepository,
  TypeOrmProcessedEventStore,
} from '@app/messaging';
import type {
  EventEnvelope,
  RefundChargeRequest,
  SettleHoldRequest,
} from '@app/contracts';
import { EVENT_TYPES } from '@app/contracts';
import { EVENTS_EXCHANGE } from '@app/messaging/amqp-topology.js';
import { envelopeOf, fromDbRow } from '@app/messaging/outbox/outbox-row.js';

import { HoldCoreRepository } from '../../../apps/inventory/src/modules/seat-hold/hold-core.repository.js';
import { HoldCoreService } from '../../../apps/inventory/src/modules/seat-hold/services/hold-core.service.js';
import { HoldSettlementService } from '../../../apps/inventory/src/modules/seat-hold/services/hold-settlement.service.js';
import { AvailabilityCountsRepository } from '../../../apps/inventory/src/modules/seats/repositories/availability-counts.repository.js';
import { AvailabilityPublisher } from '../../../apps/inventory/src/modules/seats/services/availability-publisher.service.js';

import {
  TEST_MASKED_NATIONAL_ID,
  TEST_TRAVEL_CLASS,
  testQuotedLeg,
  testTicketSigner,
} from './ticket-fixture.js';
import { BookingDraftEntity } from '../../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';
import { TicketEntity } from '../../../apps/booking/src/modules/flow/entities/ticket.entity.js';
import { BookingFlowRepository } from '../../../apps/booking/src/modules/flow/booking-flow.repository.js';
import { TicketIssuerService } from '../../../apps/booking/src/modules/flow/services/ticket-issuer.service.js';
import { BookingConfirmationService } from '../../../apps/booking/src/modules/flow/services/booking-confirmation.service.js';
import type { FlowGrpcClientsService } from '../../../apps/booking/src/modules/flow/services/flow-grpc-clients.service.js';
import {
  PaymentSucceededConsumer,
  createPaymentSucceededSubscriptions,
} from '../../../apps/booking/src/modules/flow/payment-succeeded.consumer.js';

import { buildPaymentSucceeded } from '../../../apps/payment/src/modules/charges/payment-events.factory.js';
import { PaymentDoubleService } from '../../../apps/payment/src/modules/charges/services/payment-double.service.js';
import { PaymentChargeRepository } from '../../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { ChargeCardRepository } from '../../../apps/payment/src/modules/charges/repositories/charge-card.repository.js';
import type { PaymentIntentService } from '../../../apps/payment/src/modules/charges/services/payment-intent.service.js';
import { PaymentChargeEntity } from '../../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { SavedCardEntity } from '../../../apps/payment/src/modules/cards/entities/saved-card.entity.js';

const MINUTE = 60_000;
const TRAVEL_CLASS = randomUUID();
const STATIONS = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

// The direct-service fixture covers SQL and AMQP. The recovery suite separately
// boots booking's production module in an abruptly terminated OS process.

export function isolatedConfirmationEndpoints(databases: {
  inventory: string;
  booking: string;
  payment: string;
}): { rabbit: string } {
  const postgresPort = process.env.POSTGRES_HOST_PORT?.trim() || '15432';
  const amqpPort = process.env.AMQP_HOST_PORT?.trim() || '15673';
  const rabbit = new URL(process.env.HOLDS_TEST_RABBITMQ_URL ?? '');
  if (
    rabbit.protocol !== 'amqp:' ||
    rabbit.hostname !== '127.0.0.1' ||
    rabbit.port !== amqpPort
  ) {
    throw new Error(
      `TA-107 fixtures require the local compose RabbitMQ on 127.0.0.1:${amqpPort}`,
    );
  }
  for (const [role, value] of Object.entries(databases)) {
    const url = new URL(value);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== postgresPort ||
      url.pathname !== `/${role}` ||
      url.username !== role
    ) {
      throw new Error(
        `TA-107 fixtures require the ${role} role/database on 127.0.0.1:${postgresPort}`,
      );
    }
  }
  // AmqpClientService reads this directly; nothing else in this process may set it.
  process.env.RABBITMQ_URL = rabbit.href;
  return { rabbit: rabbit.href };
}

/** One real OutboxRelayService instance, driven by hand via `runOnce()`. */
export async function outboxRelayFor(
  source: DataSource,
  cls: ClsService,
): Promise<{
  outbox: TypeOrmOutboxRepository;
  unitOfWork: TypeOrmUnitOfWork;
  amqp: AmqpClientService;
  runOnce: () => Promise<number>;
  close: () => Promise<void>;
}> {
  const initializer = new DataSourceInitializer(source);
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  const amqp = new AmqpClientService();
  await amqp.onModuleInit();
  const publisher = new EventPublisherService(amqp);
  const relay = new OutboxRelayService(
    unitOfWork,
    outbox,
    publisher,
    cls,
    new SchemaReadinessGate(),
  );
  return {
    outbox,
    unitOfWork,
    amqp,
    runOnce: () => relay.runOnce(),
    close: () => amqp.onApplicationShutdown(),
  };
}

export interface BookingSagaInstance {
  repository: BookingFlowRepository;
  confirmation: BookingConfirmationService;
  consumer: PaymentSucceededConsumer;
  consumerService: EventConsumerService;
  deliveries: { eventId: string; contentHash: string }[];
  relayOnce: () => Promise<number>;
  startConsumer: () => Promise<void>;
  stopConsumer: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boots booking's real saga pieces against the real booking database and a
 * real RabbitMQ consumer. `clients.settleHold`/`refundCharge` are wired to
 * whatever the caller passes -- real in-process inventory/payment calls.
 */
export async function bookingSagaInstance(
  source: DataSource,
  clients: FlowGrpcClientsService,
  cls: ClsService,
): Promise<BookingSagaInstance> {
  const initializer = new DataSourceInitializer(source);
  const repository = new BookingFlowRepository(
    source.getRepository(BookingDraftEntity),
    source.getRepository(TicketEntity),
  );
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  const ticketIssuer = new TicketIssuerService(testTicketSigner());
  const confirmation = new BookingConfirmationService(
    repository,
    clients,
    ticketIssuer,
    unitOfWork,
    outbox,
  );
  const consumer = new PaymentSucceededConsumer(repository);

  const amqp = new AmqpClientService();
  await amqp.onModuleInit();
  const processedEvents = new TypeOrmProcessedEventStore(initializer);
  const republisher = new MessageRepublisher(amqp);
  const failures = new EventFailureRouter(republisher, processedEvents);
  const subscriptions = createPaymentSucceededSubscriptions(consumer);
  const consumerService = new EventConsumerService(
    subscriptions,
    amqp,
    processedEvents,
    cls,
    failures,
  );
  const deliveries: BookingSagaInstance['deliveries'] = [];
  const handleMessage = consumerService.handleMessage.bind(consumerService);
  consumerService.handleMessage = async (subscription, message, channel) => {
    await handleMessage(subscription, message, channel);
    deliveries.push({
      eventId: message.properties.messageId,
      contentHash: createHash('sha256').update(message.content).digest('hex'),
    });
  };

  // Booking's own outbox needs a relay too, for booking.confirmed and the rest.
  const publisherAmqp = new AmqpClientService();
  await publisherAmqp.onModuleInit();
  const publisher = new EventPublisherService(publisherAmqp);
  const relay = new OutboxRelayService(
    unitOfWork,
    outbox,
    publisher,
    cls,
    new SchemaReadinessGate(),
  );

  return {
    repository,
    confirmation,
    consumer,
    consumerService,
    deliveries,
    relayOnce: () => relay.runOnce(),
    startConsumer: () => consumerService.onApplicationBootstrap(),
    stopConsumer: () => consumerService.beforeApplicationShutdown(),
    close: async () => {
      await consumerService.beforeApplicationShutdown();
      await amqp.onApplicationShutdown();
      await publisherAmqp.onApplicationShutdown();
    },
  };
}

/** A real HoldSettlementService, constructed directly, no gRPC hop. */
export function inventorySettlementFor(
  source: DataSource,
): HoldSettlementService {
  const initializer = new DataSourceInitializer(source);
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  const availability = new AvailabilityPublisher(
    outbox,
    new AvailabilityCountsRepository(),
  );
  return new HoldSettlementService(
    new HoldCoreRepository(),
    unitOfWork,
    availability,
  );
}

export function inventoryHoldServiceFor(source: DataSource): HoldCoreService {
  const initializer = new DataSourceInitializer(source);
  const unitOfWork = new TypeOrmUnitOfWork(initializer);
  const outbox = new TypeOrmOutboxRepository(initializer);
  return new HoldCoreService(new HoldCoreRepository(), unitOfWork, outbox);
}

/** The production payment double's refund, not a hand-written SQL imitation. */
export function paymentServiceFor(
  paymentSource: DataSource,
): PaymentDoubleService {
  const unusedIntents = new Proxy({} as PaymentIntentService, {
    get: () => {
      throw new Error(
        'This seeded-charge fixture must not create Stripe intents.',
      );
    },
  });
  return new PaymentDoubleService(
    new PaymentChargeRepository(
      paymentSource.getRepository(PaymentChargeEntity),
    ),
    new ChargeCardRepository(paymentSource.getRepository(SavedCardEntity)),
    unusedIntents,
  );
}

/** Direct-service adapter only; the recovery suite uses real gRPC clients. */
export function clientsFor(
  settlement: HoldSettlementService,
  paymentSource: DataSource,
  inventorySource: DataSource,
): FlowGrpcClientsService {
  const payment = paymentServiceFor(paymentSource);
  return {
    settleHold: (request: SettleHoldRequest) => settlement.settle(request),
    refundCharge: (request: RefundChargeRequest) => payment.refund(request),
    releaseHold: (request: { ownerId: string; bookingKey: string }) => {
      return inventoryHoldServiceFor(inventorySource).releaseHold(request);
    },
  } as unknown as FlowGrpcClientsService;
}

interface SeededTrip {
  tripId: string;
  seatIds: string[];
}

async function seedTrip(
  source: DataSource,
  seatCount: number,
): Promise<SeededTrip> {
  const tripId = randomUUID();
  const coachId = randomUUID();
  const departureAt = new Date(Date.now() + 2 * 60 * MINUTE);

  await source.query(
    `INSERT INTO inventory_trip (id, status, timetable_version, train_id, train_number, service_date)
     VALUES ($1, 'on_sale', 1, $2, 777, '2026-11-22')`,
    [tripId, randomUUID()],
  );
  for (let position = 0; position < 4; position += 1) {
    const at = new Date(departureAt.getTime() + position * 10 * MINUTE);
    const arrival = position === 0 ? null : at;
    const departure = position === 3 ? null : at;
    await source.query(
      `INSERT INTO trip_stop (trip_id, position, station_id, arrival_at, departure_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tripId, position, STATIONS[position], arrival, departure],
    );
  }
  await source.query(
    `INSERT INTO trip_coach
       (id, trip_id, coach_number, position, travel_class_id,
        travel_class_name_en, travel_class_name_ar)
     VALUES ($1, $2, 1, 0, $3, 'Economy', 'اقتصادية')`,
    [coachId, tripId, TRAVEL_CLASS],
  );
  const seatIds: string[] = [];
  for (let seatNumber = 1; seatNumber <= seatCount; seatNumber += 1) {
    const seatId = randomUUID();
    seatIds.push(seatId);
    await source.query(
      `INSERT INTO trip_seat
         (id, trip_id, trip_coach_id, seat_number, travel_class_id,
          row_number, side, seat_index_in_side)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [
        seatId,
        tripId,
        coachId,
        String(seatNumber),
        TRAVEL_CLASS,
        Math.ceil(seatNumber / 2),
        seatNumber % 2 === 1 ? 'left' : 'right',
      ],
    );
  }
  return { tripId, seatIds };
}

export interface LiveBooking {
  id: string;
  tripId: string;
  travelClassId: string;
  ownerId: string;
  passengers: string[];
  legs: string[];
  totalPiastres: number;
  paymentReference: string;
  holdId: string;
}

/** A real hold, a real awaiting_payment draft, and a real succeeded charge. */
export async function aLiveHoldAwaitingPayment(
  inventorySource: DataSource,
  bookingSource: DataSource,
  paymentSource: DataSource,
  props: { totalPiastres?: number; passengers?: number } = {},
): Promise<LiveBooking> {
  const totalPiastres = props.totalPiastres ?? 6955;
  const passengerCount = props.passengers ?? 2;
  const bookingId = randomUUID();
  const ownerId = randomUUID();
  const trip = await seedTrip(inventorySource, 8);
  const passengers = Array.from({ length: passengerCount }, () => randomUUID());

  const holdService = inventoryHoldServiceFor(inventorySource);
  const legInput = {
    tripId: trip.tripId,
    travelClassId: TRAVEL_CLASS,
    originStationId: STATIONS[0],
    destinationStationId: STATIONS[2],
  };
  const snapshot = await holdService.createHold({
    ownerId,
    bookingKey: bookingId,
    legs: [legInput],
    passengers: passengers.map((ref) => ({
      passengerRef: ref,
      identities: [
        {
          tripId: trip.tripId,
          passengerToken: `${ref}:${trip.tripId}`,
          passengerKeyVersion: 1,
        },
      ],
    })),
  });

  const paymentChargeId = randomUUID();
  await paymentSource.query(
    `INSERT INTO payment_charge
       (id, booking_reference, idempotency_key, amount_piastres, currency, status)
     VALUES ($1, $2, $3, $4, 'EGP', 'succeeded')`,
    [paymentChargeId, bookingId, `booking:${bookingId}:charge`, totalPiastres],
  );

  const passengerSnapshot = passengers.map((ref) => ({
    passengerRef: ref,
    displayName: ref,
    maskedNationalId: TEST_MASKED_NATIONAL_ID,
    identities: [
      {
        tripId: trip.tripId,
        passengerToken: `${ref}:${trip.tripId}`,
        passengerKeyVersion: 1,
      },
    ],
  }));

  // A real draft has its class and quoted legs from the price lock (BR-30);
  // the confirm step copies each ticket's snapshot from them (TA-108).
  await bookingSource.query(
    `INSERT INTO booking_draft
       (id, user_id, flow_state, status, total_piastres, payment_reference,
         hold_id, correlation_id, passenger_snapshot, hold_intent, hold_snapshot,
         travel_class, quoted_legs)
      VALUES ($1, $2, 'awaiting_payment', 'PENDING', $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)`,
    [
      bookingId,
      ownerId,
      totalPiastres,
      paymentChargeId,
      snapshot.holdId,
      randomUUID(),
      JSON.stringify(passengerSnapshot),
      JSON.stringify({ legs: [legInput], passengerRefs: passengers }),
      JSON.stringify(snapshot),
      JSON.stringify(TEST_TRAVEL_CLASS),
      JSON.stringify([testQuotedLeg(trip.tripId)]),
    ],
  );

  return {
    id: bookingId,
    tripId: trip.tripId,
    travelClassId: TRAVEL_CLASS,
    ownerId,
    passengers,
    legs: [trip.tripId],
    totalPiastres,
    paymentReference: paymentChargeId,
    holdId: snapshot.holdId,
  };
}

export async function expireTheHold(
  inventorySource: DataSource,
  booking: LiveBooking,
): Promise<void> {
  const past = new Date(Date.now() - MINUTE);
  await inventorySource.query(
    `UPDATE seat_hold_group SET expires_at = $2 WHERE id = $1`,
    [booking.holdId, past],
  );
  await inventorySource.query(
    `UPDATE seat_occupation SET hold_expires_at = $2 WHERE hold_id = $1 AND state = 'held'`,
    [booking.holdId, past],
  );
}

export async function sellEverySeatInClass(
  inventorySource: DataSource,
  tripId: string,
  travelClassId: string,
): Promise<void> {
  const rows: { id: string }[] = await inventorySource.query(
    `SELECT id FROM trip_seat WHERE trip_id = $1 AND travel_class_id = $2`,
    [tripId, travelClassId],
  );
  for (const row of rows) {
    await inventorySource.query(
      `UPDATE seat_occupation SET released_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE trip_seat_id = $1 AND released_at IS NULL`,
      [row.id],
    );
    await inventorySource.query(
      `INSERT INTO seat_occupation (id, trip_seat_id, trip_id, segment, state, hold_expires_at)
       VALUES ($1, $2, $3, '[0,1000)'::int4range, 'sold', NULL)`,
      [randomUUID(), row.id, tripId],
    );
  }
}

export async function publishPaymentSucceeded(
  paymentOutboxRelay: Awaited<ReturnType<typeof outboxRelayFor>>,
  booking: LiveBooking,
  overrides: { eventId?: string; amountPiastres?: number } = {},
): Promise<EventEnvelope> {
  const event = buildPaymentSucceeded({
    eventId: overrides.eventId ?? randomUUID(),
    correlationId: randomUUID(),
    occurredAt: new Date(),
    payload: {
      bookingReference: booking.id,
      paymentReference: booking.paymentReference,
      amountPiastres: overrides.amountPiastres ?? booking.totalPiastres,
      currency: 'EGP',
      stripeEventId: overrides.eventId ?? randomUUID(),
    },
  });
  const persisted = await paymentOutboxRelay.unitOfWork.withTransaction(
    async (ctx) => {
      await paymentOutboxRelay.outbox.append(ctx, event);
      const [row] = await entityManagerOf(ctx).query(
        'SELECT * FROM outbox_event WHERE id = $1',
        [event.id],
      );
      // JSONB normalizes payload key order. Replay the relay's stored envelope,
      // not the pre-persistence factory object, to preserve every published byte.
      return envelopeOf(fromDbRow(row));
    },
  );
  await paymentOutboxRelay.runOnce();
  return persisted;
}

/** Model an at-least-once relay replay: every envelope byte is unchanged. */
export async function redeliverPaymentSucceeded(
  relay: Awaited<ReturnType<typeof outboxRelayFor>>,
  envelope: EventEnvelope,
): Promise<void> {
  await new EventPublisherService(relay.amqp).publishConfirmed(envelope);
}

/** Durable bindings with no listener allow observing independently relayed outcomes. */
export async function outcomeQueueFor(
  amqp: AmqpClientService,
  eventTypes: readonly string[] = [
    EVENT_TYPES.bookingConfirmed,
    EVENT_TYPES.bookingRefunded,
    EVENT_TYPES.bookingSeatsChanged,
  ],
): Promise<{ queue: string; close: () => Promise<void> }> {
  const channel = await amqp.ensureChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  const queue = `test.booking-confirmation.${randomUUID()}`;
  await channel.assertQueue(queue, { durable: true });
  for (const eventType of eventTypes)
    await channel.bindQueue(queue, EVENTS_EXCHANGE, eventType);
  return {
    queue,
    close: async () => {
      await channel.deleteQueue(queue);
    },
  };
}

/** Bounded condition polling; never a fixed sleep or a background polling loop. */
export async function waitFor<T>(
  probe: () => Promise<T>,
  ready: (value: T) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const value = await probe();
    if (ready(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

export async function processedPaymentEvent(
  source: DataSource,
  eventId: string,
): Promise<unknown[]> {
  return source.query(
    'SELECT event_id, status, attempt_count FROM processed_event WHERE event_id = $1',
    [eventId],
  );
}

/**
 * Drives the saga like the worker would, one `run()` per visible step, until
 * the flow reaches a terminal state or `stopAtSagaStep` is seen. The event
 * itself arrives asynchronously through the real consumer, so this also
 * absorbs that delivery latency.
 */
export async function driveSaga(
  saga: Pick<BookingSagaInstance, 'repository' | 'confirmation' | 'relayOnce'>,
  bookingId: string,
  options: { stopAtSagaStep?: string; timeoutMs?: number } = {},
): Promise<void> {
  const end = performance.now() + (options.timeoutMs ?? 15_000);
  while (performance.now() < end) {
    const draft = await saga.repository.findById(bookingId);
    if (!draft) throw new Error('Booking vanished mid-saga.');
    if (options.stopAtSagaStep && draft.sagaStep === options.stopAtSagaStep) {
      await saga.relayOnce();
      return;
    }
    if (draft.flowState === 'confirmed' || draft.flowState === 'refunded') {
      await saga.relayOnce();
      return;
    }
    if (
      draft.sagaStep === 'payment_recorded' ||
      draft.sagaStep === 'settled' ||
      draft.sagaStep === 'refunding'
    ) {
      await saga.confirmation.run(bookingId);
    }
    await saga.relayOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Saga for ${bookingId} did not finish in time.`);
}

export async function state(
  source: DataSource,
  booking: LiveBooking,
): Promise<string> {
  const [row]: { flow_state: string }[] = await source.query(
    `SELECT flow_state FROM booking_draft WHERE id = $1`,
    [booking.id],
  );
  return row.flow_state;
}

export async function sagaStep(
  source: DataSource,
  booking: LiveBooking,
): Promise<string | null> {
  const [row]: { saga_step: string | null }[] = await source.query(
    `SELECT saga_step FROM booking_draft WHERE id = $1`,
    [booking.id],
  );
  return row.saga_step;
}

export async function ticketCount(
  source: DataSource,
  booking: LiveBooking,
): Promise<number> {
  const [row]: { count: string }[] = await source.query(
    `SELECT count(*)::text AS count FROM ticket WHERE booking_reference = $1`,
    [booking.id],
  );
  return Number(row.count);
}

export async function soldCount(
  inventorySource: DataSource,
  tripId: string,
): Promise<number> {
  const [row]: { count: string }[] = await inventorySource.query(
    `SELECT count(*)::text AS count FROM seat_occupation
     WHERE trip_id = $1 AND state = 'sold' AND released_at IS NULL`,
    [tripId],
  );
  return Number(row.count);
}

export async function soldCountForBooking(
  inventorySource: DataSource,
  booking: LiveBooking,
): Promise<number> {
  const [row]: { count: string }[] = await inventorySource.query(
    `SELECT count(*)::text AS count FROM seat_occupation
     WHERE hold_id = $1 AND state = 'sold' AND released_at IS NULL`,
    [booking.holdId],
  );
  return Number(row.count);
}

export async function refundedAmount(
  source: DataSource,
  booking: LiveBooking,
): Promise<number> {
  const [row]: { amount: number }[] = await source.query(
    `SELECT (payload->>'amountPiastres')::int AS amount
       FROM outbox_event
      WHERE event_type = 'booking.refunded'
        AND payload->>'bookingReference' = $1`,
    [booking.id],
  );
  return row?.amount ?? 0;
}

export async function publishedCount(
  source: DataSource,
  eventType: string,
  booking: LiveBooking,
): Promise<number> {
  const [row]: { count: string }[] = await source.query(
    `SELECT count(*)::text AS count FROM outbox_event
      WHERE event_type = $1 AND payload->>'bookingReference' = $2
        AND published_at IS NOT NULL`,
    [eventType, booking.id],
  );
  return Number(row.count);
}

export async function clsInstance(): Promise<ClsService> {
  const module = await Test.createTestingModule({
    imports: [ClsModule.forRoot()],
  }).compile();
  await module.init();
  return module.get(ClsService);
}
