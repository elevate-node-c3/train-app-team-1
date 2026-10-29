import { Injectable } from '@nestjs/common';

/** A dependency a readiness report should include beyond the database. */
export interface DependencyHealthContributor {
  /** The key it appears under in the report, e.g. 'broker'. */
  readonly name: string;
  check(): Promise<{ ready: boolean; message?: string }>;
}

/**
 * Contributors push themselves in; nothing pulls them.
 *
 * A pull would mean `@app/common` importing the libraries it reports on, and
 * `HealthModule` importing `MessagingModule` for the broker check is what made
 * the two libraries mutually dependent.
 *
 * Unavailable means not ready. A dependency the service can degrade around
 * rather than fail on — Redis — is reported by `HealthService` directly,
 * because that is a judgement about one named dependency, not a severity knob
 * worth generalising before there is a second case.
 */
@Injectable()
export class DependencyHealthRegistry {
  private readonly contributors = new Map<
    string,
    DependencyHealthContributor
  >();

  register(contributor: DependencyHealthContributor): () => void {
    this.contributors.set(contributor.name, contributor);
    return () => this.contributors.delete(contributor.name);
  }

  all(): DependencyHealthContributor[] {
    return [...this.contributors.values()];
  }
}
