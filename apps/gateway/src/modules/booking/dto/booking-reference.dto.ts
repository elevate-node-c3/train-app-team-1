import { IsUUID } from 'class-validator';

/**
 * A booking's own id, which is how every step after submission names it.
 * booking_draft.id is a uuid, so a malformed reference is refused here rather
 * than reaching the column.
 */
export class BookingReferenceParamDto {
  @IsUUID()
  bookingReference!: string;
}
