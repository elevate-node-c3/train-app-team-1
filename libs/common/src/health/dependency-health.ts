import { Injectable } from '@nestjs/common';

/** A dependency a readiness report should include beyond the database. */
export interface DependencyHealthContributor {
  /** The key it appears under in the report, e.g. 'broker'. */
  readonly name: string;
  check(): Promise<{ ready: boolean; message?: string }>;
}

/**
 * Contributors register themselves to avoid circular library imports.
 * Unavailable contributors make the service not ready. HealthService reports
 * Redis separately because Redis outages only degrade the service.
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
