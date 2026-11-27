import { Injectable } from '@nestjs/common';
import { ErrorCode, type EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { PaymentError } from '../payment-error.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import { PaymentDoubleService } from '../services/payment-double.service.js';
import { parseTicketCancelledEvent } from './ticket-cancelled.parser.js';

/** Refunds one ticket's booking-decided fare share; never calls booking/inventory. */
@Injectable()
export class TicketCancelledConsumer implements EventHandlerPort {
  constructor(
    private readonly charges: PaymentChargeRepository,
    private readonly paymentDouble: PaymentDoubleService,
  ) {}

  async handle(
    envelope: EventEnvelope,
    _attempt: number,
  ): Promise<EventHandlingResult> {
    const payload = parseTicketCancelledEvent(envelope);
    const charge = await this.charges.findByReference(
      payload.paymentReference,
      payload.bookingReference,
    );
    if (!charge) return { status: 'skipped', skipReason: 'unknown_charge' };

    let status: string;
    try {
      status = (
        await this.paymentDouble.refund({
          bookingReference: payload.bookingReference,
          paymentReference: payload.paymentReference,
          idempotencyKey: `ticket:${payload.ticketId}:refund`,
          amountPiastres: payload.refundPiastres,
        })
      ).status;
    } catch (error: unknown) {
      // The charge can disappear after the lookup; anything else is retried.
      if (
        error instanceof PaymentError &&
        error.code === ErrorCode.RESOURCE_NOT_FOUND
      ) {
        return { status: 'skipped', skipReason: 'unknown_charge' };
      }
      throw error;
    }

    if (status === 'REFUNDED' || status === 'ALREADY_REFUNDED') {
      return { status: 'handled' };
    }
    if (status === 'NOT_REFUNDABLE') {
      return { status: 'skipped', skipReason: 'not_refundable' };
    }
    throw new Error(`Unexpected refund status: ${status}`);
  }
}
