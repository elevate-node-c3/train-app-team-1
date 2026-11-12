import type { OperationsAuditEntity } from './entities/operations-audit.entity.js';

export interface OperationsAuditFilter {
  trainId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  /** The `id` of the last entry a previous page returned. */
  cursor?: string;
}

export interface OperationsAuditPage {
  entries: OperationsAuditEntity[];
  nextCursor: string | null;
}
