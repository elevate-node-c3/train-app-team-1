/**
 * Allocation tiers for group seat placement.
 * Fixed fallback order: SIDE_BY_SIDE -> SAME_COACH -> SPLIT.
 */
export enum AllocationOutcome {
  SIDE_BY_SIDE = 'SIDE_BY_SIDE',
  SAME_COACH = 'SAME_COACH',
  SPLIT = 'SPLIT',
}

/**
 * Split notice payload returned when group seats must be split across coaches.
 */
export interface SplitNoticePayload {
  code: string;
  message: string;
  messageEn: string;
}

/**
 * Bilingual split notice constant for groups split across coaches.
 */
export const SEATS_SPLIT_NOTICE: Readonly<SplitNoticePayload> = Object.freeze({
  code: 'SEATS_SPLIT_NOTICE',
  message: 'تم توزيع المقاعد عبر أكثر من عربة لعدم توفر مقاعد متجاورة كافية',
  messageEn:
    'Seats have been split across coaches because consecutive seats were unavailable',
});

/**
 * Seat assigned to a passenger in a hold response.
 */
export interface AssignedSeat {
  seatId: string;
  coachNumber: number;
  seatNumber: string;
  rowNumber: number;
  label?: string;
}

/**
 * Request to hold seats for a group on a trip segment.
 */
export interface HoldSeatsRequest {
  tripId: string;
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  groupSize: number;
  ttlSeconds?: number;
  bookingId?: string;
}

/**
 * Response returned by InventoryService.HoldSeats on success.
 */
export interface HoldSeatsResponse {
  holdId: string;
  allocationOutcome: AllocationOutcome;
  seats: AssignedSeat[];
  expiresAt: string;
  splitNotice?: SplitNoticePayload;
}

/**
 * Request to release previously held seats (e.g. for saga compensation).
 */
export interface ReleaseSeatsRequest {
  holdId: string;
}

/**
 * Response returned by InventoryService.ReleaseSeats.
 */
export interface ReleaseSeatsResponse {
  success: boolean;
}
