import { availableParallelism, arch, cpus, platform, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DataSource } from 'typeorm';
import {
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_HELD_EVENT_TYPE,
  HOLD_LIFECYCLE_PAYLOAD_KEYS,
  type HoldLifecyclePayloadV1,
} from '@app/contracts';
import {
  closeInventoryDataSource,
  inventoryDataSource,
  truncateInventory,
} from './support/inventory-database.js';
import {
  HOUR_MS,
  assertNoExpiryBinding,
  expirySnapshot,
  failFirstExpiryMark,
  holdEventCapture,
  inventoryExpiryInstance,
  isolatedHoldEndpoints,
  rabbitManagement,
  seedHoldGroups,
  waitForSnapshot,
  type HoldEventCapture,
  type InventoryExpiryInstance,
  type SeededHoldGroups,
} from './support/hold-fixture.js';

let source: DataSource;
let capture: HoldEventCapture | undefined;
let instances: InventoryExpiryInstance[] = [];
let cleanup: (() => Promise<void>)[] = [];
const execute = promisify(execFile);

/** docker-compose.yml's own project name; nothing else may be targeted. */
const COMPOSE_PROJECT = 'train-app';

async function brokerCommand(action: 'stop' | 'start'): Promise<void> {
  isolatedHoldEndpoints();
  // Only ever the broker of this machine's compose project, by name, and only
  // stop/start it: never `down`, never a volume, never PostgreSQL.
  await execute(
    'docker',
    ['compose', '-p', COMPOSE_PROJECT, action, 'rabbitmq'],
    {
      cwd: process.cwd(),
      timeout: 45_000,
    },
  );
  if (action === 'start') {
    const end = performance.now() + 120_000;
    while (performance.now() < end) {
      try {
        await rabbitManagement('overview');
        return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Isolated broker did not become ready after restart');
  }
}

async function instance(
  label: string,
  start = true,
): Promise<InventoryExpiryInstance> {
  const created = await inventoryExpiryInstance(source, label, start);
  instances.push(created);
  return created;
}

async function checkpoint() {
  const before = performance.now();
  const [row]: { now: Date }[] = await source.query(
    'SELECT clock_timestamp() AS now',
  );
  return { now: row.now, before, after: performance.now() };
}

function capturedExpired(seed: SeededHoldGroups) {
  const ids = new Set(seed.groups.map((group) => group.id));
  return capture!
    .byType(HOLD_EXPIRED_EVENT_TYPE)
    .filter((record) => ids.has(record.event.payload.holdId));
}

async function complete(seed: SeededHoldGroups, timeoutMs = 90_000) {
  const snapshot = await waitForSnapshot(
    source,
    (current) => {
      if (capture!.errors.length > 0)
        throw new Error(capture!.errors.join('; '));
      return (
        current.expired === seed.groups.length &&
        current.versionTwo === seed.groups.length &&
        current.unreleased === 0 &&
        current.expiredEvents === seed.groups.length &&
        current.publishedExpired === seed.groups.length &&
        current.publishedHeld === seed.groups.length &&
        capturedExpired(seed).length === seed.groups.length
      );
    },
    timeoutMs,
  );
  // Both the broker receipt and a committed-row snapshot precede this DB clock.
  return { snapshot, checkpoint: await checkpoint() };
}

async function assertWholeGroups(seed: SeededHoldGroups): Promise<void> {
  const [facts]: {
    legs: number;
    passengers: number;
    assignments: number;
    brokenReceipts: number;
    mismatchedRelease: number;
  }[] = await source.query(`SELECT
    (SELECT count(*)::integer FROM seat_hold_leg) AS legs,
    (SELECT count(*)::integer FROM seat_hold_passenger) AS passengers,
    (SELECT count(*)::integer FROM seat_hold_assignment) AS assignments,
    (SELECT count(*)::integer FROM seat_hold_assignment a
      LEFT JOIN seat_hold_passenger p ON p.hold_id = a.hold_id AND p.trip_id = a.trip_id AND p.passenger_ref = a.passenger_ref
      LEFT JOIN seat_occupation o ON o.hold_id = a.hold_id AND o.trip_id = a.trip_id AND o.trip_seat_id = a.trip_seat_id
      WHERE p.id IS NULL OR o.id IS NULL OR o.passenger_token <> p.passenger_token) AS "brokenReceipts",
    (SELECT count(*)::integer FROM seat_occupation o JOIN seat_hold_group h ON h.id = o.hold_id
      WHERE o.released_at IS DISTINCT FROM h.released_at) AS "mismatchedRelease"`);
  expect(facts).toEqual({
    legs: seed.expectedLegs,
    passengers: seed.expectedAssignments,
    assignments: seed.expectedAssignments,
    brokenReceipts: 0,
    mismatchedRelease: 0,
  });

  const rows: {
    id: string;
    payload: HoldLifecyclePayloadV1;
    occurredAt: Date;
    correlationId: string;
    perHold: number;
  }[] = await source.query(
    `SELECT id, payload,
    occurred_at AS "occurredAt", correlation_id AS "correlationId",
    count(*) OVER (PARTITION BY payload->>'holdId')::integer AS "perHold"
    FROM outbox_event WHERE event_type = $1`,
    [HOLD_EXPIRED_EVENT_TYPE],
  );
  expect(rows).toHaveLength(seed.groups.length);
  const groups = new Map(seed.groups.map((group) => [group.id, group]));
  for (const row of rows) {
    const group = groups.get(row.payload.holdId);
    expect(group).toBeDefined();
    expect(row.perHold).toBe(1);
    expect(row.payload).toMatchObject({
      aggregateVersion: 2,
      state: 'EXPIRED',
      reason: 'expired',
      expiresAt: seed.deadline.toISOString(),
    });
    expect(row.payload.legs).toHaveLength(group!.legs.length);
    expect(Object.keys(row.payload).sort()).toEqual(
      [...HOLD_LIFECYCLE_PAYLOAD_KEYS].sort(),
    );
    const delivered = capture!.records.get(row.id);
    expect(delivered).toBeDefined();
    expect(delivered!.event.payload).toEqual(row.payload);
    expect(delivered!.event.occurredAt).toBe(row.occurredAt.toISOString());
    expect(delivered!.event.correlationId).toBe(row.correlationId);
  }
  expect(
    new Set(capturedExpired(seed).map((record) => record.event.id)).size,
  ).toBe(seed.groups.length);
  expect(
    capture!
      .byType(HOLD_HELD_EVENT_TYPE)
      .map((record) => record.event.id)
      .sort(),
  ).toEqual([...seed.heldEventIds].sort());
}

async function returnedCounts(
  results: readonly { type: string; value: unknown }[],
): Promise<number> {
  let total = 0;
  for (const result of results) {
    if (result.type !== 'return') continue;
    try {
      const value = await result.value;
      if (typeof value === 'number') total += value;
    } catch {
      // Failed attempts remain visible in the persisted retry assertions.
    }
  }
  return total;
}

beforeAll(async () => {
  const endpoints = isolatedHoldEndpoints();
  vi.stubEnv('RABBITMQ_URL', endpoints.rabbit);
  vi.stubEnv('OUTBOX_RELAY_ENABLED', 'true');
  vi.stubEnv('OUTBOX_BATCH_SIZE', '100');
  vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '100');
  vi.stubEnv('OUTBOX_PUBLISH_CONCURRENCY', '32');
  vi.stubEnv('HOLD_EXPIRY_WORKER_ENABLED', 'true');
  vi.stubEnv('HOLD_EXPIRY_BATCH_SIZE', '500');
  vi.stubEnv('HOLD_EXPIRY_POLL_INTERVAL_MS', '250');
  vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', '5000');
  // Check the live isolated broker before any inventory cleanup is permitted.
  const rabbit = await rabbitManagement<{
    rabbitmq_version: string;
    erlang_version: string;
    node: string;
  }>('overview');
  source = await inventoryDataSource();
  const [postgres] =
    await source.query(`SELECT version(), current_database() AS database, current_user AS role,
    current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit`);
  expect(postgres.database).toBe('inventory');
  expect(postgres.role).toBe('inventory');
  expect(postgres.fsync).toBe('on');
  expect(postgres.synchronous_commit).toBe('on');
  console.info(
    'HOLDS_ENVIRONMENT',
    JSON.stringify({
      postgres,
      rabbit: {
        version: rabbit.rabbitmq_version,
        erlang: rabbit.erlang_version,
        node: rabbit.node,
      },
      host: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model,
        logicalCpus: cpus().length,
        availableParallelism: availableParallelism(),
        memoryBytes: totalmem(),
      },
      fixture: {
        expiryInstances: 2,
        expiryBatch: 500,
        expiryIdleMs: 250,
        relayBatch: 100,
        relayIdleMs: 100,
        parallelConfirms: 32,
        confirmTimeoutMs: 5000,
        extraHeldTraffic: 10_000,
        fixtureDeadlineLeadMs: 30_000,
        queueType: 'quorum',
      },
    }),
  );
}, 180_000);

beforeEach(async () => {
  isolatedHoldEndpoints();
  await truncateInventory(source);
  capture = await holdEventCapture();
});

afterEach(async () => {
  try {
    await Promise.all(instances.map((running) => running.close()));
  } finally {
    instances = [];
    for (const dispose of cleanup.reverse()) await dispose();
    cleanup = [];
    if (capture) await capture.close();
    capture = undefined;
    if (source?.isInitialized) await truncateInventory(source);
  }
});

afterAll(async () => {
  await closeInventoryDataSource();
  vi.unstubAllEnvs();
});

describe('TA-70 real isolated expiry SLO and recovery', () => {
  it('retains a mandatory return without a binding and recovers the same expired event ID', async () => {
    await capture!.unbindExpiry();
    await assertNoExpiryBinding();
    await instance('mandatory-return');
    const seed = await seedHoldGroups(source, 1, -1);
    const failed = await waitForSnapshot(
      source,
      (snapshot) =>
        snapshot.expiredEvents === 1 &&
        snapshot.publishedExpired === 0 &&
        snapshot.failedEvents > 0,
      15_000,
    );
    const [pending]: {
      id: string;
      attemptCount: number;
      lastError: string;
      retryAheadMs: number;
    }[] = await source.query(
      `SELECT id, attempt_count AS "attemptCount", last_error AS "lastError",
      (extract(epoch FROM next_attempt_at - clock_timestamp()) * 1000)::double precision AS "retryAheadMs"
      FROM outbox_event WHERE event_type = $1`,
      [HOLD_EXPIRED_EVENT_TYPE],
    );
    expect(pending.attemptCount).toBeGreaterThan(0);
    expect(pending.lastError).toContain('AMQP mandatory return 312 NO_ROUTE');
    expect(pending.retryAheadMs).toBeLessThan(61_000);
    expect(capturedExpired(seed)).toHaveLength(0);
    expect(failed.versionTwo).toBe(1);
    const recoveryBegan = performance.now();
    await capture!.bindExpiry();
    await complete(seed);
    await assertWholeGroups(seed);
    expect(capturedExpired(seed)[0].event.id).toBe(pending.id);
    console.info(
      'HOLDS_MANDATORY_RETURN_RECOVERY',
      JSON.stringify({
        eventId: pending.id,
        attempts: pending.attemptCount,
        recoveryMs: performance.now() - recoveryBegan,
      }),
    );
  }, 180_000);

  it('expires all 10000 whole groups and durably captures and commits every expired event by T+60 seconds', async () => {
    const first = await instance('load-one', false);
    const second = await instance('load-two', false);
    const runs = [first, second].map((running) => ({
      worker: vi.spyOn(running.worker, 'runOnce'),
      relay: vi.spyOn(running.relay, 'runOnce'),
    }));
    const seed = await seedHoldGroups(source, 10_000, 30_000);
    await Promise.all([first.start(), second.start()]);
    expect(first.migrations.hasCompleted).toBe(true);
    expect(second.migrations.hasCompleted).toBe(true);
    const connections = await Promise.all(
      [first.source, second.source].map(async (pool) => {
        const [row] = await pool.query(
          "SELECT pg_backend_pid() AS pid, current_setting('application_name') AS application",
        );
        return row;
      }),
    );
    expect(new Set(connections.map((row) => row.pid)).size).toBe(2);
    const armed = await checkpoint();
    expect(armed.now.getTime()).toBeLessThan(seed.deadline.getTime());
    const deadline = seed.deadline.getTime() + 60_000;
    let deadlineReported = false;
    const started = performance.now();
    await waitForSnapshot(
      source,
      (snapshot) => {
        if (capture!.errors.length > 0)
          throw new Error(capture!.errors.join('; '));
        if (!deadlineReported && snapshot.now.getTime() >= deadline) {
          deadlineReported = true;
          console.info(
            'HOLDS_DEADLINE_SNAPSHOT',
            JSON.stringify({
              ...snapshot,
              capturedExpired: capturedExpired(seed).length,
            }),
          );
        }
        return (
          snapshot.expired === 10_000 &&
          snapshot.versionTwo === 10_000 &&
          snapshot.unreleased === 0 &&
          snapshot.expiredEvents === 10_000 &&
          snapshot.publishedExpired === 10_000 &&
          snapshot.publishedHeld === 10_000 &&
          capturedExpired(seed).length === 10_000
        );
      },
      180_000,
    );
    const finished = await checkpoint();
    const snapshot = await expirySnapshot(source);
    const lastCapture = Math.max(
      ...capturedExpired(seed).map((record) => record.firstAt),
    );
    const maxCaptureUpperMs =
      finished.now.getTime() +
      lastCapture -
      finished.before -
      seed.deadline.getTime();
    console.info(
      'HOLDS_LOAD_RESULT',
      JSON.stringify({
        groups: 10_000,
        legs: seed.expectedLegs,
        assignments: seed.expectedAssignments,
        heldEvents: 10_000,
        expiredUniqueEvents: capturedExpired(seed).length,
        extraExpiredDeliveries: capturedExpired(seed).reduce(
          (sum, record) => sum + record.deliveries - 1,
          0,
        ),
        seedMs: seed.seedMs,
        elapsedAfterSeedMs: performance.now() - started,
        expiryT: seed.deadline.toISOString(),
        committedAndCapturedAt: finished.now.toISOString(),
        allCommittedAndCapturedLatencyMs:
          finished.now.getTime() - seed.deadline.getTime(),
        maxReleaseMs: snapshot.maxReleaseMs,
        maxPublishedMs: snapshot.maxPublishedMs,
        maxCaptureUpperMs,
        clockSampleUncertaintyMs: finished.after - finished.before,
        connections,
      }),
    );
    // Maxima and a post-capture/post-commit checkpoint, never a percentile gate.
    expect(snapshot.maxReleaseMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.maxReleaseMs).toBeLessThanOrEqual(60_000);
    expect(snapshot.maxPublishedMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.maxPublishedMs).toBeLessThanOrEqual(60_000);
    expect(maxCaptureUpperMs).toBeLessThanOrEqual(60_000);
    expect(finished.now.getTime()).toBeLessThanOrEqual(deadline);
    expect(snapshot.occupations).toBe(13_000);
    await assertWholeGroups(seed);

    const scans = runs.map((run) => run.worker.mock.calls.length);
    await waitForSnapshot(
      source,
      () =>
        runs.every(
          (run, index) => run.worker.mock.calls.length >= scans[index] + 2,
        ),
      5_000,
    );
    const repeated = await expirySnapshot(source);
    expect(repeated).toMatchObject({
      groups: 10_000,
      expired: 10_000,
      versionTwo: 10_000,
      expiredEvents: 10_000,
      unreleased: 0,
    });
    expect(capturedExpired(seed)).toHaveLength(10_000);
    await Promise.all([first.close(), second.close()]);
    const contributions = await Promise.all(
      runs.map(async (run) => ({
        expiredGroups: await returnedCounts(run.worker.mock.results),
        publishedEvents: await returnedCounts(run.relay.mock.results),
      })),
    );
    expect(
      contributions.every(
        (contribution) =>
          contribution.expiredGroups > 0 && contribution.publishedEvents > 0,
      ),
    ).toBe(true);
    expect(
      contributions.reduce(
        (sum, contribution) => sum + contribution.expiredGroups,
        0,
      ),
    ).toBe(10_000);
    expect(
      contributions.reduce(
        (sum, contribution) => sum + contribution.publishedEvents,
        0,
      ),
    ).toBe(20_000);
    console.info('HOLDS_INSTANCE_CONTRIBUTIONS', JSON.stringify(contributions));
  }, 600_000);

  it('restarts from hour-aged deadlines and unpublished expiry events after injected broker unavailability', async () => {
    const unavailable = await instance('outage', false);
    const failedPublisher = vi
      .spyOn(unavailable.publisher, 'publishConfirmed')
      .mockRejectedValue(new Error('HOLDS injected broker unavailable'));
    await unavailable.start();
    const seed = await seedHoldGroups(source, 200, -HOUR_MS);
    await waitForSnapshot(
      source,
      (snapshot) =>
        snapshot.expired === 200 &&
        snapshot.expiredEvents === 200 &&
        snapshot.unreleased === 0 &&
        snapshot.failedEvents > 0,
      30_000,
    );
    expect(capturedExpired(seed)).toHaveLength(0);
    await unavailable.close();
    failedPublisher.mockRestore();

    // Deadlines were seeded an hour old. Change only retry eligibility, never
    // the committed event ID, payload, or occurrence time seen by a publisher.
    await source.query(
      `UPDATE outbox_event SET next_attempt_at = clock_timestamp() - interval '1 hour'
       WHERE event_type = $1 AND published_at IS NULL`,
      [HOLD_EXPIRED_EVENT_TYPE],
    );
    const pending: {
      id: string;
      ageMs: number;
      occurredAt: Date;
      payload: HoldLifecyclePayloadV1;
    }[] = await source.query(
      `SELECT id, occurred_at AS "occurredAt", payload,
      (extract(epoch FROM clock_timestamp() - (payload->>'expiresAt')::timestamptz) * 1000)::double precision AS "ageMs"
      FROM outbox_event WHERE event_type = $1 AND published_at IS NULL`,
      [HOLD_EXPIRED_EVENT_TYPE],
    );
    expect(pending).toHaveLength(200);
    expect(pending.every((event) => event.ageMs >= HOUR_MS)).toBe(true);
    const recoveryBegan = performance.now();
    await Promise.all([instance('recovery-one'), instance('recovery-two')]);
    await complete(seed);
    await assertWholeGroups(seed);
    expect(
      capturedExpired(seed)
        .map((record) => record.event.id)
        .sort(),
    ).toEqual(pending.map((event) => event.id).sort());
    for (const original of pending) {
      expect(capture!.records.get(original.id)?.event).toMatchObject({
        id: original.id,
        occurredAt: original.occurredAt.toISOString(),
        payload: original.payload,
      });
    }
    console.info(
      'HOLDS_AGED_RESTART_RESULT',
      JSON.stringify({
        groups: 200,
        pendingExpiredEvents: pending.length,
        minDeadlineAgeMs: Math.min(...pending.map((event) => event.ageMs)),
        recoveryMs: performance.now() - recoveryBegan,
        actualOneHourSoak: false,
      }),
    );
  }, 180_000);

  it('replays the same ID after real confirmation followed by a PostgreSQL mark rollback', async () => {
    cleanup.push(await failFirstExpiryMark(source));
    await instance('mark-rollback');
    const seed = await seedHoldGroups(source, 10, -1);
    await complete(seed);
    await waitForSnapshot(
      source,
      () => capturedExpired(seed).some((record) => record.deliveries > 1),
      10_000,
    );
    await assertWholeGroups(seed);
    const [audit]: {
      rows: number;
      badClock: number;
      minPostTransactionMs: number;
    }[] = await source.query(`SELECT count(*)::integer AS rows,
      count(*) FILTER (WHERE published_at <= transaction_started_at OR published_at > observed_at)::integer AS "badClock",
      (min(extract(epoch FROM published_at - transaction_started_at)) * 1000)::double precision AS "minPostTransactionMs"
      FROM holds_fixture_mark_audit`);
    expect(audit.rows).toBe(10);
    expect(audit.badClock).toBe(0);
    expect(audit.minPostTransactionMs).toBeGreaterThan(0);
    console.info(
      'HOLDS_CONFIRM_MARK_REPLAY',
      JSON.stringify({
        ...audit,
        replayedIds: capturedExpired(seed)
          .filter((record) => record.deliveries > 1)
          .map((record) => record.event.id),
      }),
    );
  }, 180_000);

  it('recovers unchanged event IDs after closing only the publishing connection during a confirm', async () => {
    const running = await instance('connection-loss', false);
    const channel = await running.amqp.ensureConfirmChannel();
    const publish = channel.publish.bind(channel);
    const transport = channel.connection as typeof channel.connection & {
      stream: Duplex;
    };
    let disconnected = false;
    vi.spyOn(channel, 'publish').mockImplementation(
      (exchange, key, body, options, confirm) => {
        const accepted = publish(exchange, key, body, options, confirm);
        if (!disconnected && options?.type === HOLD_EXPIRED_EVENT_TYPE) {
          disconnected = true;
          transport.stream.destroy(
            new Error('HOLDS injected producer disconnect'),
          );
        }
        return accepted;
      },
    );
    await running.start();
    const seed = await seedHoldGroups(source, 10, -1);
    await complete(seed);
    await assertWholeGroups(seed);
    expect(disconnected).toBe(true);
    const [retried]: { count: number }[] = await source.query(
      'SELECT count(*)::integer AS count FROM outbox_event WHERE event_type = $1 AND attempt_count > 0',
      [HOLD_EXPIRED_EVENT_TYPE],
    );
    expect(retried.count).toBeGreaterThan(0);
    expect(capture!.errors).toEqual([]);
    console.info(
      'HOLDS_CONNECTION_RECOVERY',
      JSON.stringify({
        retriedExpiredEvents: retried.count,
        uniqueExpiredIds: capturedExpired(seed).length,
        sharedBrokerRestarted: false,
      }),
    );
  }, 180_000);

  it('keeps expiry running during a real broker outage and retains durable messages across restart', async () => {
    const queue = capture!.queue;
    await capture!.disconnect();
    capture = undefined;
    let stopped = false;
    try {
      const seed = await seedHoldGroups(source, 10, 60_000);
      await instance('real-broker-restart');
      await waitForSnapshot(
        source,
        (snapshot) =>
          snapshot.publishedHeld === seed.groups.length &&
          snapshot.expired === 0,
        20_000,
      );
      stopped = true;
      await brokerCommand('stop');

      const offline = await waitForSnapshot(
        source,
        (snapshot) =>
          snapshot.expired === seed.groups.length &&
          snapshot.unreleased === 0 &&
          snapshot.failedEvents > 0,
        90_000,
      );
      expect(offline.publishedExpired).toBe(0);
      const pending: { id: string }[] = await source.query(
        `SELECT id FROM outbox_event WHERE event_type = $1 AND published_at IS NULL ORDER BY id`,
        [HOLD_EXPIRED_EVENT_TYPE],
      );
      expect(pending).toHaveLength(seed.groups.length);

      await brokerCommand('start');
      stopped = false;
      capture = await holdEventCapture(queue);
      await complete(seed);
      expect(capture.byType(HOLD_HELD_EVENT_TYPE)).toHaveLength(
        seed.groups.length,
      );
      expect(
        capturedExpired(seed)
          .map((record) => record.event.id)
          .sort(),
      ).toEqual(pending.map((row) => row.id));
      await assertWholeGroups(seed);
      expect(capture.errors).toEqual([]);
      console.info(
        'HOLDS_REAL_BROKER_RESTART',
        JSON.stringify({
          groups: seed.groups.length,
          expiredWhileBrokerOffline: offline.expired,
          durableHeldMessagesRecovered:
            capture.byType(HOLD_HELD_EVENT_TYPE).length,
          unchangedExpiredIdsRecovered: pending.length,
        }),
      );
    } finally {
      if (stopped) await brokerCommand('start');
      // Ordinary cleanup removes only the owned queue, including after a refusal.
      capture ??= await holdEventCapture(queue);
    }
  }, 300_000);
});
