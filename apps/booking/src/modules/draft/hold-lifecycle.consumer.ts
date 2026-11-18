import { Injectable } from '@nestjs/common';
import {
  HOLD_EVENT_VERSION,
  HOLD_HELD_EVENT_TYPE,
  HOLD_RELEASED_EVENT_TYPE,
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_EXTENDED_EVENT_TYPE,
  type EventEnvelope,
} from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
  EventSubscription,
} from '@app/messaging';
import { BookingDraftStore } from './booking-draft.store.js';
import { BookingDraftService } from './booking-draft.service.js';
import { parseHoldLifecycleEvent } from './hold-lifecycle.parser.js';

export const BOOKING_HOLD_QUEUES = {
  [HOLD_HELD_EVENT_TYPE]: 'booking.hold-lifecycle.held',
  [HOLD_RELEASED_EVENT_TYPE]: 'booking.hold-lifecycle.released',
  [HOLD_EXPIRED_EVENT_TYPE]: 'booking.hold-lifecycle.expired',
  [HOLD_EXTENDED_EVENT_TYPE]: 'booking.hold-lifecycle.extended',
} as const;

export function createHoldLifecycleSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  // A shared queue would deliver each event to a random type-specific parser.
  return Object.entries(BOOKING_HOLD_QUEUES).map(([eventType, queueName]) => ({
    eventType,
    queueName,
    version: HOLD_EVENT_VERSION,
    handler,
  }));
}

@Injectable()
export class BookingHoldLifecycleConsumer implements EventHandlerPort {
  constructor(
    private readonly store: BookingDraftStore,
    private readonly drafts: BookingDraftService,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseHoldLifecycleEvent(envelope);
    const draft = await this.store.applyEvent(payload);
    if (!draft || !draft.holdIntent)
      return { status: 'skipped', skipReason: 'unknown_booking_intent' };
    // Commit the event fence first. Held events carry no seats; fetch their
    // receipt outside the DB transaction and retry safely on dependency failure.
    if (draft.holdState === 'HELD' && draft.reconciliationPending) {
      await this.drafts.reconcileHold(draft.userId, draft.id);
    }
    return { status: 'handled' };
  }
}
