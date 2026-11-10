import { Injectable } from '@nestjs/common';

/**
 * A barrier background work awaits so it cannot query a table before the
 * migration that creates it has run. Starts open: a service with no
 * `MigrationModule` never constructs a runner, so nobody closes it.
 */
@Injectable()
export class SchemaReadinessGate {
  private ready: Promise<void> = Promise.resolve();
  private settle: () => void = () => {};

  /** Called from the runner's constructor, which is before any Nest hook. */
  expectMigrations(): void {
    this.ready = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  /** Settled, not succeeded: a failed migration opens the gate too. */
  markSettled(): void {
    this.settle();
  }

  get whenReady(): Promise<void> {
    return this.ready;
  }
}
