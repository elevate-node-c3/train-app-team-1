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
 * One seat the allocator assigned. MT-02's HoldSeatAssignment carries the same
 * fields plus the passenger and segment it was assigned for.
 */
export interface AssignedSeat {
  seatId: string;
  coachNumber: number;
  seatNumber: string;
  rowNumber: number;
  label?: string;
}
