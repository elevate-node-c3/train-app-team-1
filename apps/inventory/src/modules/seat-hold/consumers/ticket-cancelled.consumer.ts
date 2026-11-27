import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';

import { SoldSeatReleaseService } from '../services/sold-seat-release.service.js';
import { parseTicketCancelledEvent } from './ticket-cancelled.parser.js';

/** Releases exactly the cancelling passenger's sold seat; redelivery is safe. */
@Injectable()
export class TicketCancelledConsumer implements EventHandlerPort {
  constructor(private readonly releases: SoldSeatReleaseService) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseTicketCancelledEvent(envelope);
    await this.releases.release({
      bookingReference: payload.bookingReference,
      passengerRef: payload.passengerRef,
      tripId: payload.tripId,
      coachNumber: payload.coachNumber,
      seatNumber: payload.seatNumber,
    });
    return { status: 'handled' };
  }
}
