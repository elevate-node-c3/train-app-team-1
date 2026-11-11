import { getProtoPath } from '../proto-path.js';

export const INVENTORY_PACKAGE_NAME = 'train.inventory.v1';
export const INVENTORY_SERVICE_NAME = 'InventoryService';

/** Resolves inventory.proto across the source, dist and container layouts. */
export function getInventoryProtoPath(): string {
  return getProtoPath('inventory.proto');
}

export interface SeatUsageForTripsRequest {
  tripIds: string[];
}

// Counts and stations travel together -- see inventory.proto for why.
export interface TripSeatUsage {
  tripId: string;
  soldCount: number;
  heldCount: number;
  stationIdsInUse: string[];
}

export interface SeatUsageForTripsResponse {
  usages: TripSeatUsage[];
}
