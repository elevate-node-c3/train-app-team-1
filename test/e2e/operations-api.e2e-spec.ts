import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ApiResponse } from '@app/contracts';

import {
  SEARCH_FIXTURE_IDS,
  SEARCH_FIXTURE_TRAIN_NUMBERS,
} from '../../apps/catalog/src/database/seeds/search-fixture.js';
import {
  seedSearchE2e,
  type E2eSearchFixture,
} from '../../apps/catalog/src/database/seeds/today-trips.js';
import {
  EMAIL_QUEUE,
  GATEWAY_URL,
  OPERATOR_SEED_EMAIL,
  OPERATOR_SEED_PASSWORD,
  compose,
  composeUpBuild,
  seedStaff,
  stopStack,
  waitFor,
  waitForConsumer,
  waitForGateway,
  waitForServiceReady,
} from './support/stack.js';
import {
  SEARCH_STACK,
  travellerAccessToken,
} from './support/search-stack.js';

/**
 * TA-20's operator flow, through the whole stack.
 *
 * The e2e tier is the only place that can prove the gateway's operator role,
 * the REST-to-gRPC hop, catalog's publish/fare transaction, the outbox
 * invalidation that makes a new fare visible to search, and BR-52's audit
 * trail all agree with each other.
 *
 * The rules that need a controlled clock and a real Postgres transaction are
 * proven at the unit and integration tiers. What is checked here is the wiring
 * an operator actually touches.
 */

const OPERATIONS = '/api/v1/operations';
const TRIPS_SEARCH = '/api/v1/trips/search';

const OPERATOR_TRAIN_NUMBER = String(
  SEARCH_FIXTURE_TRAIN_NUMBERS.operations,
);
const RETRY_TRAIN_NUMBER = String(
  SEARCH_FIXTURE_TRAIN_NUMBERS.operationsRetry,
);

interface PublishResult {
  timetableId: string;
  version: number;
  created?: number;
  changed?: number;
  withdrawn?: number;
}

interface ChangeFareResult {
  fareId: string;
  previousAmountPiastres?: number;
  newAmountPiastres: number;
  effectiveFrom: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actorAccountId: string;
  trainId: string;
  before: unknown;
  after: unknown;
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: unknown;
}

interface AuditPage {
  entries: AuditEntry[];
  nextCursor?: string;
}

interface SearchTrip {
  tripId: string;
  trainNumber: number;
  fare: { amountMinor: number; currency: string };
}

interface SearchPage {
  trips: SearchTrip[];
}

interface Called<T> {
  status: number;
  body: ApiResponse<T>;
  correlationId: string | null;
}

interface OperatorSession {
  token: string;
  accountId: string;
}

interface AccessTokenClaims {
  sub: string;
}

let fixture: E2eSearchFixture;
let operator: OperatorSession;
let travellerToken: string;

/**
 * The same slice search needs, plus inventory: a publish asks inventory
 * whether any affected trip has sold or held seats before it writes anything.
 */
function startOperationsStack(): void {
  compose('down', '-v', '--remove-orphans');
  composeUpBuild([...SEARCH_STACK, 'inventory']);
}

function decodeClaims(token: string): AccessTokenClaims {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('The access token is not a JWT');

  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as AccessTokenClaims;
}

async function signInOperator(): Promise<OperatorSession> {
  const response = await fetch(`${GATEWAY_URL}/api/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: OPERATOR_SEED_EMAIL,
      password: OPERATOR_SEED_PASSWORD,
    }),
  });
  const body = (await response.json()) as ApiResponse<{
    tokens: { accessToken: string } | null;
  }>;

  const token = body.data?.tokens?.accessToken;
  if (response.status !== 200 || !token) {
    throw new Error(
      `operator sign-in failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  return { token, accountId: decodeClaims(token).sub };
}

async function call<T>(
  path: string,
  options: {
    method: 'GET' | 'POST';
    token: string;
    idempotencyKey?: string;
    body?: unknown;
  },
): Promise<Called<T>> {
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey
        ? { 'Idempotency-Key': options.idempotencyKey }
        : {}),
      'x-correlation-id': `e2e-operations-${randomUUID()}`,
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });

  return {
    status: response.status,
    body: (await response.json()) as ApiResponse<T>,
    correlationId: response.headers.get('x-correlation-id'),
  };
}

function publishBody(trainNumber: string) {
  return {
    trainNumber,
    runningDays: [0, 1, 2, 3, 4, 5, 6],
    effectiveFrom: fixture.today,
    stops: [
      {
        stationId: fixture.stations.ramsis,
        position: 1,
        dayOffset: 0,
        departureTime: '09:00',
      },
      {
        stationId: fixture.stations.alexandria,
        position: 2,
        dayOffset: 0,
        arrivalTime: '12:00',
      },
    ],
    coaches: [
      {
        position: 1,
        coachNumber: 1,
        travelClassId: fixture.travelClasses.first,
        coachLayoutId: SEARCH_FIXTURE_IDS.coachLayouts.first,
      },
    ],
    fares: [
      {
        travelClassId: fixture.travelClasses.first,
        originStationId: fixture.stations.ramsis,
        destinationStationId: fixture.stations.alexandria,
        amountPiastres: 15_000,
      },
    ],
  };
}

function searchTrain(token: string, trainNumber: number) {
  const query = new URLSearchParams({
    from: fixture.stations.ramsis,
    to: fixture.stations.alexandria,
    departureDate: fixture.searchDate,
    travelClassId: fixture.travelClasses.first,
    trainNumber: String(trainNumber),
  });

  return call<SearchPage>(`${TRIPS_SEARCH}?${query.toString()}`, {
    method: 'GET',
    token,
  });
}

async function tripOf(trainNumber: number): Promise<SearchTrip> {
  const { status, body } = await searchTrain(travellerToken, trainNumber);
  expect(status, JSON.stringify(body.error)).toBe(200);

  const trip = (body.data as SearchPage).trips.find(
    (candidate) => candidate.trainNumber === trainNumber,
  );
  if (!trip) throw new Error(`train ${trainNumber} is not in the search page`);
  return trip;
}

beforeAll(async () => {
  startOperationsStack();
  await waitForGateway();
  await waitForServiceReady('identity');
  await waitForServiceReady('catalog');
  await waitForServiceReady('inventory');
  await waitForServiceReady('notification');
  await waitForConsumer(EMAIL_QUEUE);

  // The operator account is identity's standalone seed; the fixture supplies
  // the network and the timetable-less trains 916/917 this file publishes.
  seedStaff();
  fixture = await seedSearchE2e();

  operator = await signInOperator();
  travellerToken = await travellerAccessToken();
}, 1_800_000);

afterAll(() => {
  stopStack();
}, 300_000);

describe('The operator flow, edge to catalog', () => {
  it('signs in as the operator, publishes train 916, changes a fare and reads the trail', async () => {
    const publishKey = `e2e-operations-publish-${randomUUID()}`;
    const publish = await call<PublishResult>(
      `${OPERATIONS}/timetables`,
      {
        method: 'POST',
        token: operator.token,
        idempotencyKey: publishKey,
        body: publishBody(OPERATOR_TRAIN_NUMBER),
      },
    );

    expect(publish.status, JSON.stringify(publish.body.error)).toBe(201);
    const published = publish.body.data as PublishResult;
    expect(published.created).toBeGreaterThan(0);
    expect(published.version).toBe(1);

    // Search is served from catalog's generated dated trips, not from the
    // publish response: the trip has to be reachable by a traveller.
    await waitFor(
      'train 916 to appear in search after the publish',
      async () => {
        const { body } = await searchTrain(
          travellerToken,
          SEARCH_FIXTURE_TRAIN_NUMBERS.operations,
        );
        return ((body.data as SearchPage).trips ?? []).some(
          (trip) =>
            trip.trainNumber === SEARCH_FIXTURE_TRAIN_NUMBERS.operations,
        );
      },
      60_000,
      2_000,
    );

    const before = await tripOf(SEARCH_FIXTURE_TRAIN_NUMBERS.operations);
    expect(before.fare).toEqual({ amountMinor: 15_000, currency: 'EGP' });

    // "Now or later": a value computed at request time is already past by the
    // time catalog validates it, so the change takes effect a few seconds out.
    // Search resolves the fare against its own clock, not the travel date, so
    // the poll below waits for that instant rather than for the next trip.
    const fareEffectiveFrom = new Date(Date.now() + 5_000).toISOString();
    const change = await call<ChangeFareResult>(`${OPERATIONS}/fares`, {
      method: 'POST',
      token: operator.token,
      idempotencyKey: `e2e-operations-fare-${randomUUID()}`,
      body: {
        trainNumber: OPERATOR_TRAIN_NUMBER,
        travelClassId: fixture.travelClasses.first,
        originStationId: fixture.stations.ramsis,
        destinationStationId: fixture.stations.alexandria,
        amountPiastres: 17_500,
        effectiveFrom: fareEffectiveFrom,
      },
    });

    expect(change.status, JSON.stringify(change.body.error)).toBe(201);
    const changed = change.body.data as ChangeFareResult;
    expect(changed.previousAmountPiastres).toBe(15_000);
    expect(changed.newAmountPiastres).toBe(17_500);
    expect(changed.effectiveFrom).toBe(fareEffectiveFrom);

    // The fare is deliberately future-dated, so it is not in force yet. Wait
    // for its instant before the first search at the new route version; a
    // search before then would cache the old amount under that version.
    await waitFor(
      'the fare to reach its effective instant',
      () => Date.now() >= Date.parse(fareEffectiveFrom) + 500,
      15_000,
      250,
    );

    // The new row is written synchronously, but search's cache is invalidated
    // by the outbox relay. Poll the traveller-visible answer, which is the one
    // the story promises.
    await waitFor(
      'the new fare to become visible to search',
      async () =>
        (await tripOf(SEARCH_FIXTURE_TRAIN_NUMBERS.operations)).fare
          .amountMinor === 17_500,
      30_000,
      2_000,
    );

    const audit = await call<AuditPage>(
      `${OPERATIONS}/audit?trainId=${SEARCH_FIXTURE_IDS.trains.operations}&limit=20`,
      { method: 'GET', token: operator.token },
    );

    expect(audit.status, JSON.stringify(audit.body.error)).toBe(200);
    const entries = (audit.body.data as AuditPage).entries;
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['timetable.published', 'fare.changed']),
    );

    const publishedEntry = entries.find(
      (entry) => entry.action === 'timetable.published',
    );
    const fareEntry = entries.find((entry) => entry.action === 'fare.changed');

    expect(publishedEntry?.actorAccountId).toBe(operator.accountId);
    expect(fareEntry?.actorAccountId).toBe(operator.accountId);
    expect(publishedEntry?.trainId).toBe(SEARCH_FIXTURE_IDS.trains.operations);
    expect(fareEntry?.trainId).toBe(SEARCH_FIXTURE_IDS.trains.operations);

    // The gateway always mints its own correlation ID; the audit must carry
    // the one each response was stamped with, not a fresh value.
    expect(publishedEntry?.correlationId).toBe(publish.correlationId);
    expect(fareEntry?.correlationId).toBe(change.correlationId);
    expect(publishedEntry?.correlationId).not.toBe(fareEntry?.correlationId);
  }, 600_000);

  it('refuses every operations route for a traveller token', async () => {
    const requests: { path: string; method: 'GET' | 'POST'; body?: unknown }[] = [
      {
        path: `${OPERATIONS}/timetables`,
        method: 'POST',
        body: publishBody(OPERATOR_TRAIN_NUMBER),
      },
      {
        path: `${OPERATIONS}/fares`,
        method: 'POST',
        body: {
          trainNumber: OPERATOR_TRAIN_NUMBER,
          travelClassId: fixture.travelClasses.first,
          originStationId: fixture.stations.ramsis,
          destinationStationId: fixture.stations.alexandria,
          amountPiastres: 17_500,
          effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
        },
      },
      {
        path: `${OPERATIONS}/audit`,
        method: 'GET',
      },
    ];

    for (const request of requests) {
      const { status, body } = await call<unknown>(request.path, {
        method: request.method,
        token: travellerToken,
        idempotencyKey: `e2e-traveller-${randomUUID()}`,
        body: request.body,
      });

      expect(status, `${request.method} ${request.path}`).toBe(403);
      expect(body.error?.code, `${request.method} ${request.path}`).toBe(
        'FORBIDDEN',
      );
    }
  }, 120_000);

  it('applies a retried publish once', async () => {
    const key = `e2e-operations-retry-${randomUUID()}`;
    const body = publishBody(RETRY_TRAIN_NUMBER);

    const first = await call<PublishResult>(`${OPERATIONS}/timetables`, {
      method: 'POST',
      token: operator.token,
      idempotencyKey: key,
      body,
    });
    expect(first.status, JSON.stringify(first.body.error)).toBe(201);

    const retry = await call<PublishResult>(`${OPERATIONS}/timetables`, {
      method: 'POST',
      token: operator.token,
      idempotencyKey: key,
      body,
    });
    expect(retry.status, JSON.stringify(retry.body.error)).toBe(201);
    expect(retry.body.data).toEqual(first.body.data);

    // A replay returns the first answer. The trail must still hold one
    // publish for this train, not two.
    const audit = await call<AuditPage>(
      `${OPERATIONS}/audit?trainId=${SEARCH_FIXTURE_IDS.trains.operationsRetry}&limit=20`,
      { method: 'GET', token: operator.token },
    );

    expect(audit.status, JSON.stringify(audit.body.error)).toBe(200);
    const publishes = (audit.body.data as AuditPage).entries.filter(
      (entry) => entry.action === 'timetable.published',
    );

    expect(publishes).toHaveLength(1);
    expect((first.body.data as PublishResult).version).toBe(1);
  }, 300_000);
});
