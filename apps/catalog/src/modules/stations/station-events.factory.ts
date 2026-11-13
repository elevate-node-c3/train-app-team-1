import {
  STATION_CHANGED_EVENT_TYPE,
  STATION_CHANGED_VERSION,
  type StationChangedEvent,
  type StationChangedPayloadV1,
} from '@app/contracts';

export function buildStationChanged(props: {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: StationChangedPayloadV1;
}): StationChangedEvent {
  return {
    id: props.eventId,
    type: STATION_CHANGED_EVENT_TYPE,
    version: STATION_CHANGED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'catalog',
    payload: props.payload,
  };
}
