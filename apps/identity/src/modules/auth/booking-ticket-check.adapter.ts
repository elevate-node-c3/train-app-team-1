import { Injectable } from '@nestjs/common';

export const BOOKING_TICKET_CHECK = Symbol('BOOKING_TICKET_CHECK');

export interface BookingTicketCheckPort {
  hasIssuedTickets(nationalId: string): Promise<boolean>;
}

@Injectable()
export class StubBookingTicketCheckAdapter implements BookingTicketCheckPort {
  async hasIssuedTickets(_nationalId: string): Promise<boolean> {
    return false;
  }
}
