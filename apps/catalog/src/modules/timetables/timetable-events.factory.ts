import {
  TIMETABLE_PUBLISHED_EVENT_TYPE,
  TIMETABLE_PUBLISHED_VERSION,
  type TimetablePublishedEvent,
} from '@app/contracts';

interface BuildTimetablePublishedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  timetableId: string;
  trainId: string;
  timetableVersion: number;
  /** In travel order; the first and last are the route's ends. */
  stationIdsInOrder: readonly string[];
}

/** Carries the stations because CAT-5 bumps route versions from them. */
export function buildTimetablePublished(
  props: BuildTimetablePublishedProps,
): TimetablePublishedEvent {
  const stations = props.stationIdsInOrder;

  return {
    id: props.eventId,
    type: TIMETABLE_PUBLISHED_EVENT_TYPE,
    version: TIMETABLE_PUBLISHED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'catalog',
    payload: {
      timetableId: props.timetableId,
      trainId: props.trainId,
      timetableVersion: props.timetableVersion,
      originStationId: stations[0],
      destinationStationId: stations[stations.length - 1],
      intermediateStationIds: stations.slice(1, -1),
    },
  };
}
