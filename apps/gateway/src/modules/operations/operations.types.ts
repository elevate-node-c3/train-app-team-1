import type { CallOptions } from '@grpc/grpc-js';
import type { Observable } from 'rxjs';
import type { CivilDateTime } from '@app/contracts';

/** Gateway RPC shapes match catalog.proto. */

export interface PublishTimetableGrpcStop {
  stationId: string;
  position: number;
  dayOffset: number;
  /** First stop has no arrival field; proto3 cannot send null. */
  arrivalTime?: string;
  /** No departure field at the last stop. */
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

/** Optional counts distinguish zero from missing values. */
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
  /** ISO timestamp. */
  effectiveFrom: string;
}

export interface ChangeFareGrpcResponse {
  fareId: string;
  /** Missing when the pair has no previous fare. */
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
  /** Always zero for now; keep it distinct from missing counts. */
  ticketsAffected?: number;
  correlationId: string;
  occurredAt: CivilDateTime;
}

export interface ListAuditEntriesGrpcResponse {
  entries: AuditEntryGrpc[];
  nextCursor?: string;
}

/** Every RPC accepts metadata and options so deadlines reach catalog. */
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

export const OPERATIONS_GRPC_CLIENT = Symbol('OPERATIONS_GRPC_CLIENT');
