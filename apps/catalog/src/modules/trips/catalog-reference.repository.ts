import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { SearchReferenceFacts } from './trip-search-validation.js';

/**
 * Resolve facts in at most three queries; batch both station IDs with ANY.
 * Pure validators decide refusals rather than the repository throwing them.
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

    // Query trains only when a train number is supplied.
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
