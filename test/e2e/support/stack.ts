import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ApiResponse, SignUpResponseDto } from '@app/contracts';
import { STAFF_SEED_ACCOUNTS } from '../../../apps/identity/src/database/seeds/staff-accounts.js';

/**
 * These Compose tests restart containers and wipe volumes, so files run serially.
 * Start only the services needed for messaging.
 */

const COMPOSE_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

export const GATEWAY_URL = `http://localhost:${process.env.GATEWAY_PORT ?? '3000'}`;
export const MAILPIT_URL = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? '8025'}`;
export const RABBITMQ_MANAGEMENT_URL = `http://127.0.0.1:${process.env.RABBITMQ_MANAGEMENT_PORT ?? '15672'}`;
export const EMAIL_QUEUE = 'notification.verification-code-issued';

/** The gateway is the only prefixed service (ADR: one public door). */
export const AUTH_BASE_URL = `${GATEWAY_URL}/api/v1/auth`;

/** Satisfies BR-02: at least 8 characters, a letter, a digit and a symbol. */
export const DEFAULT_PASSWORD = 'Str0ng!Passw0rd';

/** Reuse identity's seed accounts instead of duplicating emails and passwords. */
const [OPERATOR_SEED_ACCOUNT, CONDUCTOR_SEED_ACCOUNT] = STAFF_SEED_ACCOUNTS;

export const OPERATOR_SEED_EMAIL = OPERATOR_SEED_ACCOUNT.email;
export const CONDUCTOR_SEED_EMAIL = CONDUCTOR_SEED_ACCOUNT.email;
export const OPERATOR_SEED_PASSWORD = OPERATOR_SEED_ACCOUNT.developmentPassword;
export const CONDUCTOR_SEED_PASSWORD =
  CONDUCTOR_SEED_ACCOUNT.developmentPassword;

const COMPOSE_ENV = {
  ...process.env,
  OPERATOR_SEED_PASSWORD,
  CONDUCTOR_SEED_PASSWORD,
};

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
      env: COMPOSE_ENV,
    });
  } catch (error: unknown) {
    const failure = error as { stderr?: string; message?: string };
    throw new Error(
      `docker ${args.join(' ')} failed: ${failure.stderr ?? failure.message ?? 'unknown error'}`,
    );
  }
}

/** A service this harness can exec into or wait on. */
export type ComposeService =
  | 'postgres'
  | 'redis'
  | 'rabbitmq'
  | 'mailpit'
  | 'gateway'
  | 'identity'
  | 'notification'
  | 'catalog'
  | 'inventory';

export function compose(...args: string[]): string {
  return docker(['compose', ...args], COMPOSE_TIMEOUT_MS);
}

/**
 * Use the first-build timeout and docker() wrapper to retain stderr and
 * COMPOSE_ENV seed passwords.
 */
export function composeUpBuild(services: readonly string[]): void {
  docker(
    [
      'compose',
      'up',
      '-d',
      '--build',
      '--wait',
      '--wait-timeout',
      '600',
      ...services,
    ],
    BUILD_TIMEOUT_MS,
  );
}

export function startStack(): void {
  compose('down', '-v', '--remove-orphans');
  // Compose's --wait covers infra healthchecks, not app readiness.
  // Callers must also poll /health/ready.
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
 * Runs identity's staff seed after migration. The seeder image also holds
 * catalog's seed, so narrow it to identity to keep the auth stack independent.
 */
export function seedStaff(): void {
  const password = process.env.IDENTITY_DB_PASSWORD ?? 'identity_dev';
  docker(
    [
      'compose',
      'run',
      '--rm',
      '--no-deps',
      '--build',
      '-e',
      `DATABASE_URL=postgres://identity:${encodeURIComponent(password)}@postgres:5432/identity`,
      'seeder',
      'node',
      'dist/apps/identity/src/database/seeds/staff-accounts.seed.js',
    ],
    BUILD_TIMEOUT_MS,
  );
}

/** Retry transient failures until the readiness predicate succeeds. */
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

// Identity and notification have no host ports; probe readiness with compose exec.
// Exit nonzero on HTTP 503 or a failed request.
const READY_SCRIPT =
  "fetch('http://127.0.0.1:3000/health/ready')" +
  '.then(async (r) => { await r.text(); process.exit(r.ok ? 0 : 1); })' +
  '.catch(() => process.exit(1));';

export async function waitForServiceReady(
  service: ComposeService,
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
  password = DEFAULT_PASSWORD,
): Promise<SignUpResult> {
  const started = Date.now();
  const response = await fetch(`${AUTH_BASE_URL}/sign-up`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({ email, password, language }),
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

export interface MailpitMessageDetail extends MailpitMessage {
  Text: string;
  HTML: string;
}

export async function mailpitMessage(
  id: string,
): Promise<MailpitMessageDetail> {
  const response = await fetch(
    `${MAILPIT_URL}/api/v1/message/${encodeURIComponent(id)}`,
  );
  if (!response.ok) {
    throw new Error(`Mailpit message ${id} returned HTTP ${response.status}`);
  }
  return (await response.json()) as MailpitMessageDetail;
}

/**
 * Read codes from the body, never the subject. Prefer Text over HTML so
 * CSS colors are not mistaken for six-digit codes.
 */
export async function waitForEmailCode(
  email: string,
  subject: string,
  timeoutMs = 90_000,
): Promise<string> {
  let code: string | null = null;

  await waitFor(
    `a '${subject}' email for ${email}`,
    async () => {
      const inbox = await mailpitInbox();
      const message = inbox.messages.find(
        (candidate) =>
          candidate.Subject === subject &&
          candidate.To.some((recipient) => recipient.Address === email),
      );
      if (!message) return false;

      const detail = await mailpitMessage(message.ID);
      const body = detail.Text || stripHtml(detail.HTML ?? '');
      code = /\b(\d{6})\b/.exec(body)?.[1] ?? null;
      return code !== null;
    },
    timeoutMs,
    500,
  );

  if (code === null) {
    throw new Error(
      `The '${subject}' email for ${email} contained no six-digit code`,
    );
  }
  return code;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
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
 * The readiness route checks consumer liveness, but the broker confirms
 * the queue is actually subscribed.
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

/** Run SQL as the Postgres superuser, matching the runbook. */
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

/**
 * Revocation travels through outbox, broker and gateway asynchronously.
 * Wait for the Redis marker instead of sleeping.
 */
export function redisGet(key: string): string {
  return compose(
    'exec',
    '-T',
    'redis',
    'redis-cli',
    '--raw',
    'GET',
    key,
  ).trim();
}
