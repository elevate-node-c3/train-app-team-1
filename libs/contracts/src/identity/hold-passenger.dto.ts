import type { HoldPassengerLegIdentityInput } from '../inventory/seat-hold.dto.js';

export interface ResolveHoldPassengersRequest {
  ownerId: string;
  passengerRefs: string[];
  tripIds: string[];
}

export interface ResolvedHoldPassenger {
  passengerRef: string;
  displayName: string;
  maskedNationalId: string;
  identities: HoldPassengerLegIdentityInput[];
}

export interface ResolveHoldPassengersResponse {
  passengers: ResolvedHoldPassenger[];
}
