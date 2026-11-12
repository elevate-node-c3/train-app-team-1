import type { TrainEntity } from '../trains/entities/train.entity.js';
import type { TravelClassEntity } from '../trains/entities/travel-class.entity.js';

/**
 * What the catalogue holds for the named ids. `knownStationIds` is resolved
 * from the catalogue, not built from the request.
 */
export interface FareChangeReferences {
  train: TrainEntity | null;
  travelClass: TravelClassEntity | null;
  knownStationIds: ReadonlySet<string>;
}
