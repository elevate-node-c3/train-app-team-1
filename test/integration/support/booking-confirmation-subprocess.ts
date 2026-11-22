import { fork, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOOKING_DATABASE_URL } from './booking-database.js';

export interface ProcessMessage {
  type: string;
  eventId?: string;
  contentHash?: string;
  bookingId?: string;
  pid?: number;
}

export class BookingProcess {
  readonly messages: ProcessMessage[] = [];
  readonly child: ChildProcess;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private readonly waiters = new Set<() => void>();
  private failure: Error | undefined;
  private diagnostics = '';

  constructor(environment: Record<string, string>) {
    this.child = fork(
      fileURLToPath(
        new URL('./booking-confirmation-process.ts', import.meta.url),
      ),
      [],
      {
        execArgv: [
          '--loader',
          new URL('./booking-confirmation-loader.mjs', import.meta.url).href,
        ],
        env: {
          ...process.env,
          DATABASE_URL: BOOKING_DATABASE_URL,
          REDIS_URL: '', // Booking supports production degraded-cache startup.
          OUTBOX_RELAY_ENABLED: 'true',
          ...environment,
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    this.child.stderr?.on('data', (chunk: Buffer) => {
      let safe = chunk
        .toString()
        .replace(
          /\b(?:postgres(?:ql)?|amqps?|rediss?):\/\/[^\s'"<>]+/gi,
          '[REDACTED_URL]',
        );
      for (const [key, value] of Object.entries({
        ...process.env,
        ...environment,
      })) {
        if (
          value &&
          value.length >= 4 &&
          /password|secret|token|key|credential|url/i.test(key)
        )
          safe = safe.split(value).join('[REDACTED]');
      }
      this.diagnostics = (this.diagnostics + safe).slice(-8_192);
    });
    this.child.on('message', (message: ProcessMessage) => {
      this.messages.push(message);
      if (message.type === 'bootstrap-failed')
        this.failure = new Error(
          'Booking subprocess bootstrap failed (driver/configuration details suppressed).',
        );
      this.notify();
    });
    this.child.on('error', () => {
      this.failure = new Error('Booking subprocess could not start.');
      this.notify();
    });
    this.exited = new Promise((resolve) =>
      this.child.once('exit', (code, signal) => {
        this.failure ??= new Error(
          `Booking subprocess exited (${signal ?? code}). ${[...new Set(this.diagnostics.match(/\bERR_[A-Z_]+\b/g) ?? [])].join(', ')}`,
        );
        resolve({ code, signal });
        this.notify();
      }),
    );
  }

  private notify(): void {
    for (const wake of this.waiters) wake();
  }

  async waitForMessage(
    predicate: (message: ProcessMessage) => boolean,
    timeoutMs = 60_000,
  ): Promise<ProcessMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          finish(
            new Error('Timed out waiting for booking subprocess checkpoint.'),
          ),
        timeoutMs,
      );
      const finish = (error?: Error, message?: ProcessMessage): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve(message!);
      };
      const check = (): void => {
        const message = this.messages.find(predicate);
        if (message) finish(undefined, message);
        else if (this.failure) finish(this.failure);
      };
      this.waiters.add(check);
      check();
    });
  }

  /** SIGKILL has no application shutdown hook; Windows /F is the equivalent. */
  async killAbruptly(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      return this.exited;
    if (!this.child.pid)
      throw new Error('Booking subprocess has no process ID.');
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) =>
        execFile(
          'taskkill',
          ['/PID', String(this.child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 10_000 },
          (error) =>
            error
              ? reject(new Error('Abrupt booking process termination failed.'))
              : resolve(),
        ),
      );
    } else if (!this.child.kill('SIGKILL')) {
      throw new Error('Abrupt booking process termination failed.');
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error('Killed booking process did not report its exit.'),
              ),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return;
    // Even cleanup is bounded: a stuck production shutdown must not leak a child.
    if (this.child.connected) this.child.send({ type: 'close' });
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) await this.killAbruptly();
  }
}
