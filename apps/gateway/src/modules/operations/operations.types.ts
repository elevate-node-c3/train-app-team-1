import type { CallOptions } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
import type { CivilDateTime } from '@app/contracts';

/**
 * The operations rpcs as this gateway calls them.
 *
 * No wire-level type for these exists in `@app/contracts` -- `catalog.dto.ts`
 * only carries the search surface, and `operations.dto.ts` carries catalog's
 * own domain shapes, which use `number`/`null` where the wire uses an
 * `optional` presence-tracked field. These interfaces are the wire shapes
 * themselves, matching `catalog.proto` and the catalog-side
 * `operations.grpc.controller.ts` that already names them the same way.
 */

export interface PublishTimetableGrpcStop {
  stationId: string;
  position: number;
  dayOffset: number;
  /** Absent on the wire at the first stop -- proto3 has no `null`. */
  arrivalTime?: string;
  /** Absent on the wire at the last stop. */
  departureTime?: string;
}

export interface PublishTimetableGrpcCoach {
  position: number;
  coachNumber: number;
  travelClassId: string;
  coachLayoutId: string;
}

export interface PublishTimetableGrpcFare {
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
}

export interface PublishTimetableGrpcRequest {
  trainNumber: string;
  runningDays: number[];
  effectiveFrom: string;
  stops: PublishTimetableGrpcStop[];
  coaches: PublishTimetableGrpcCoach[];
  fares: PublishTimetableGrpcFare[];
}

/**
 * `created`/`changed`/`withdrawn` are `optional` on the wire (Task 10) so a
 * genuine republish-with-no-change arrives as a real `0`, not an absent key.
 * A consumer must read these as "present with value N" vs "absent", never
 * assume absent means zero.
 */
export interface PublishTimetableGrpcResponse {
  timetableId: string;
  version: number;
  created?: number;
  changed?: number;
  withdrawn?: number;
}

export interface ChangeFareGrpcRequest {
  trainNumber: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
  /** ISO instant. */
  effectiveFrom: string;
}

export interface ChangeFareGrpcResponse {
  fareId: string;
  /** Absent exactly on the pair's first-ever fare. */
  previousAmountPiastres?: number;
  newAmountPiastres: number;
  effectiveFrom: string;
}

export interface ListAuditEntriesGrpcRequest {
  trainId?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

export interface AuditEntryGrpc {
  id: string;
  action: string;
  actorAccountId: string;
  trainId: string;
  beforeJson: string;
  afterJson: string;
  /** Always 0 this sprint, but `optional` for the same zero-vs-absent reason. */
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: CivilDateTime;
}

export interface ListAuditEntriesGrpcResponse {
  entries: AuditEntryGrpc[];
  nextCursor?: string;
}

/**
 * `metadata` and `options` are declared on every method so a deadline can be
 * threaded through the `ClientGrpc` proxy, matching `CatalogGrpcClient`.
 */
export interface OperationsGrpcClient {
  publishTimetable(
    data: PublishTimetableGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<PublishTimetableGrpcResponse>;

  changeFare(
    data: ChangeFareGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ChangeFareGrpcResponse>;

  listAuditEntries(
    data: ListAuditEntriesGrpcRequest,
    metadata?: unknown,
    options?: CallOptions,
  ): Observable<ListAuditEntriesGrpcResponse>;
}

/** The resolved service proxy. */
export const OPERATIONS_GRPC_CLIENT = Symbol('OPERATIONS_GRPC_CLIENT');
