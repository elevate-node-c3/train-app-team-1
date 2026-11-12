import type { TrainEntity } from '../trains/entities/train.entity.js';
import type { TravelClassEntity } from '../trains/entities/travel-class.entity.js';

/**
 * What the catalogue actually holds for the ids a fare change named.
 *
 * `knownStationIds` is the real set, resolved from the catalogue rather than
 * built from the request's own ids -- the same reasoning
 * `PublishReferences` states for the publish flow.
 */
export interface FareChangeReferences {
  train: TrainEntity | null;
  travelClass: TravelClassEntity | null;
  knownStationIds: ReadonlySet<string>;
}
