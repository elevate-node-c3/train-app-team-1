import { Injectable } from '@nestjs/common';
import { resolveMessageWithParams, type SupportedLanguage } from '@app/common';
import type { SearchOneWayTripsResponse } from '@app/contracts';

import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';

/** What the REST endpoint answers with. */
export interface SearchTripsResult
  extends Omit<SearchOneWayTripsResponse, 'emptyResult'> {
  /**
   * Present only when `trips` is empty. The reason is kept beside the sentence
   * so a client can branch on the code and still have something to show.
   */
  emptyResult?: {
    reason: string;
    message: string;
  };
}

/**
 * Shapes a search for the HTTP edge.
 *
 * The one piece of real work here is the language. Catalog returns a reason
 * enum and the values that go in the sentence; the words are chosen here,
 * because `Accept-Language` is resolved at the edge and nowhere else (BR-56).
 * That is what keeps catalog free of any language at all, and why the message
 * catalogue is keyed by the wire enum -- no mapping table in between.
 */
@Injectable()
export class CatalogService {
  constructor(private readonly catalog: CatalogGrpcClientService) {}

  async searchOneWay(
    query: SearchTripsDto,
    language: SupportedLanguage,
  ): Promise<SearchTripsResult> {
    const response = await this.catalog.searchOneWayTrips({
      originStationId: query.from,
      destinationStationId: query.to,
      departureDate: query.departureDate,
      travelClassId: query.travelClassId,
      ...(query.trainNumber === undefined
        ? {}
        : { trainNumber: query.trainNumber }),
      ...(query.language === undefined ? {} : { language: query.language }),
    });

    const { emptyResult, ...rest } = response;

    return {
      ...rest,
      // proto3 omits an empty repeated field, so a day with no trips arrives
      // with no `trips` key at all. The REST contract must not make a client
      // guess that absent means empty -- it is the difference between "no
      // trains" and "the server forgot to tell me".
      trips: response.trips ?? [],
      dateStrip: response.dateStrip ?? [],
      ...(emptyResult
        ? {
            emptyResult: {
              reason: emptyResult.reason,
              message: resolveMessageWithParams(
                emptyResult.reason,
                language,
                emptyResult.params ?? {},
              ),
            },
          }
        : {}),
    };
  }
}
