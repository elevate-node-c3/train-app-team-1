import { getProtoPath } from '../proto-path.js';

export const INVENTORY_PACKAGE_NAME = 'train.inventory.v1';
export const INVENTORY_SERVICE_NAME = 'InventoryService';

export const INVENTORY_RPC_NAMES = [
  'SeatUsageForTrips',
  'HoldSeats',
  'ReleaseSeats',
  'CreateHold',
  'GetHold',
  'ReleaseHold',
  'ExtendHold',
] as const;

/** Resolves inventory.proto across the source, dist and container layouts. */
export function getInventoryProtoPath(): string {
  return getProtoPath('inventory.proto');
}

export interface SeatUsageForTripsRequest {
  tripIds: string[];
}

// Counts and stations travel together; see inventory.proto.
export interface TripSeatUsage {
  tripId: string;
  soldCount: number;
  heldCount: number;
  stationIdsInUse: string[];
}

export interface SeatUsageForTripsResponse {
  usages: TripSeatUsage[];
}

export * from './seat-allocation.dto.js';
export * from './seat-hold.dto.js';
