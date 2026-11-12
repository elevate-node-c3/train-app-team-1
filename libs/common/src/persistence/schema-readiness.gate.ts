import { Injectable } from '@nestjs/common';

/**
 * Background work waits for migrations to settle. Starts open for services
 * without MigrationModule.
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
