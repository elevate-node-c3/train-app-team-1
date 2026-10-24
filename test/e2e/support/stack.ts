import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ApiResponse, SignUpResponseDto } from '@app/contracts';

/**
 * Shared harness for the two outbox e2e specs.
 *
 * The tests drive the real Compose stack: they stop and start containers and
 * wipe volumes, so the e2e config runs files one at a time. Only the services
 * the backbone needs are started; building the other four would add minutes and
 * prove nothing about messaging.
 */

const COMPOSE_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

export const GATEWAY_URL = `http://localhost:${process.env.GATEWAY_PORT ?? '3000'}`;
export const MAILPIT_URL = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? '8025'}`;
export const RABBITMQ_MANAGEMENT_URL = `http://127.0.0.1:${process.env.RABBITMQ_MANAGEMENT_PORT ?? '15672'}`;
export const EMAIL_QUEUE = 'notification.verification-code-issued';

const RABBITMQ_USER = process.env.RABBITMQ_USER ?? 'train_app';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD ?? 'train_app';

const OUTBOX_STACK = [
  'postgres',
  'redis',
  'rabbitmq',
  'mailpit',
  'gateway',
  'identity',
  'notification',
] as const;

function docker(args: string[], timeoutMs: number): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (error: unknown) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error(
      `docker ${args.join(' ')} failed: ${failure.stderr ?? failure.message ?? 'unknown error'}`,
    );
  }
}

export function compose(...args: string[]): string {
  return docker(['compose', ...args], COMPOSE_TIMEOUT_MS);
}

/** Builds and starts the backbone's slice of the Compose project. */
export function startStack(): void {
  compose('down', '-v', '--remove-orphans');
  // `--wait` is not a readiness gate for the apps: Compose only understands the
  // infra healthchecks. The caller polls `/health/ready` below.
  docker(
    [
      'compose',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '600',
      ...OUTBOX_STACK,
    ],
    BUILD_TIMEOUT_MS,
  );
}

export function stopStack(): void {
  compose('down', '-v', '--remove-orphans');
}

/**
 * Polls until `predicate` is truthy, swallowing transient failures. Every
 * readiness wait in the suite goes through this rather than sleeping a fixed
 * amount and hoping.
 */
export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix =
    lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}${suffix}`,
  );
}

export async function waitForGateway(timeoutMs = 180_000): Promise<void> {
  await waitFor(
    'the gateway to answer HTTP',
    async () => {
      try {
        const response = await fetch(`${GATEWAY_URL}/health/live`);
        return response.ok;
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
}

// Identity and notification publish no host port; their own HTTP listener is
// reachable only inside the container, so readiness is probed with `compose
// exec`. The route throws 503 while a dependency is not ready, which makes the
// process exit code the whole predicate.
const READY_SCRIPT =
  "fetch('http://127.0.0.1:3000/health/ready')" +
  '.then(async (r) => { await r.text(); process.exit(r.ok ? 0 : 1); })' +
  '.catch(() => process.exit(1));';

export async function waitForServiceReady(
  service: 'identity' | 'notification',
  timeoutMs = 180_000,
): Promise<void> {
  await waitFor(
    `${service} to report ready`,
    () => {
      try {
        compose('exec', '-T', service, 'node', '-e', READY_SCRIPT);
        return true;
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
}

export interface SignUpResult {
  status: number;
  elapsedMs: number;
  body: ApiResponse<SignUpResponseDto>;
}

export async function signUp(
  email: string,
  language: 'ar' | 'en',
  correlationId = `e2e-${randomUUID()}`,
): Promise<SignUpResult> {
  const started = Date.now();
  const response = await fetch(`${GATEWAY_URL}/identity/sign-up`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({ email, language }),
  });
  const body = (await response.json()) as ApiResponse<SignUpResponseDto>;

  return { status: response.status, elapsedMs: Date.now() - started, body };
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string; Name: string }[];
}

export interface MailpitInbox {
  total: number;
  messages: MailpitMessage[];
}

export async function mailpitInbox(): Promise<MailpitInbox> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages`);
  if (!response.ok) {
    throw new Error(`Mailpit returned HTTP ${response.status}`);
  }
  return (await response.json()) as MailpitInbox;
}

export async function clearMailpit(): Promise<void> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/messages`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Mailpit clear returned HTTP ${response.status}`);
  }
}

export async function waitForInboxSize(
  expected: number,
  timeoutMs = 90_000,
): Promise<MailpitInbox> {
  await waitFor(
    `${expected} email(s) in Mailpit`,
    async () => (await mailpitInbox()).total >= expected,
    timeoutMs,
    250,
  );
  return mailpitInbox();
}

export interface QueueStats {
  messages: number;
  consumers: number;
  message_stats?: {
    deliver?: number;
    deliver_get?: number;
  };
}

export async function queueStats(queue: string): Promise<QueueStats> {
  const credentials = Buffer.from(
    `${RABBITMQ_USER}:${RABBITMQ_PASSWORD}`,
  ).toString('base64');
  const response = await fetch(
    `${RABBITMQ_MANAGEMENT_URL}/api/queues/%2F/${queue}`,
    { headers: { authorization: `Basic ${credentials}` } },
  );
  if (!response.ok) {
    throw new Error(`RabbitMQ management API returned HTTP ${response.status}`);
  }
  return (await response.json()) as QueueStats;
}

/** Management stats lag the broker by a few seconds, so both counters matter. */
export function deliveredCount(stats: QueueStats): number {
  return stats.message_stats?.deliver_get ?? stats.message_stats?.deliver ?? 0;
}

/**
 * `/health/ready` checks Postgres and the broker, not whether the subscription
 * actually attached. A consumer that failed to bind is healthy-looking, so the
 * specs that need delivery gate on the broker's own consumer count.
 */
export async function waitForConsumer(
  queue: string,
  timeoutMs = 90_000,
): Promise<void> {
  await waitFor(
    `${queue} to have a consumer`,
    async () => (await queueStats(queue)).consumers > 0,
    timeoutMs,
  );
}

/** Runs SQL through the superuser, the same operator path the runbook uses. */
export function psql(
  database: 'identity' | 'notification',
  sql: string,
): string {
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    'postgres',
    '--dbname',
    database,
    '--no-password',
    '--tuples-only',
    '--no-align',
    '--command',
    sql,
  ).trim();
}
