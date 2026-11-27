import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
  type TicketCancelledEvent,
  type TicketCancelledPayloadV1,
} from '@app/contracts';

interface BuildProps<TPayload> {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: TPayload;
}

export function buildTicketCancelled(
  props: BuildProps<TicketCancelledPayloadV1>,
): TicketCancelledEvent {
  return {
    id: props.eventId,
    type: TICKET_CANCELLED_EVENT_TYPE,
    version: TICKET_CANCELLED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: props.payload,
  };
}
