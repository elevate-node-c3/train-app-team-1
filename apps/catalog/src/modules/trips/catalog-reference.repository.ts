import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { SearchReferenceFacts } from './trip-search-validation.js';

/**
 * Looks up the ids a search referenced, so the pure validators can decide
 * whether to refuse. Three statements at most, none of them growing with the
 * request -- the station lookup takes both ids in one `= ANY`.
 *
 * Deliberately returns facts rather than throwing: the refusal itself is
 * `validateSearchReferences`, which stays unit-testable with no database.
 */
@Injectable()
export class CatalogReferenceRepository {
  constructor(private readonly dataSource: DataSource) {}

  async resolveReferences(params: {
    stationIds: string[];
    travelClassId: string;
    trainNumber: number | null;
  }): Promise<SearchReferenceFacts & { trainId: string | null }> {
    const stationIds = [...new Set(params.stationIds)];

    const stations: { id: string; is_active: boolean }[] =
      stationIds.length === 0
        ? []
        : await this.dataSource.query(
            'SELECT id, is_active FROM station WHERE id = ANY($1::uuid[])',
            [stationIds],
          );

    const travelClasses: { id: string }[] = await this.dataSource.query(
      'SELECT id FROM travel_class WHERE id = $1::uuid',
      [params.travelClassId],
    );

    // Only asked when the caller narrowed the search, so the common path costs
    // two statements rather than three.
    const trains: { id: string }[] =
      params.trainNumber === null
        ? []
        : await this.dataSource.query(
            'SELECT id FROM train WHERE train_number = $1',
            [params.trainNumber],
          );

    return {
      knownStationIds: new Set(stations.map((row) => row.id)),
      activeStationIds: new Set(
        stations.filter((row) => row.is_active).map((row) => row.id),
      ),
      travelClassExists: travelClasses.length > 0,
      trainExists: trains.length > 0,
      trainId: trains[0]?.id ?? null,
    };
  }
}
