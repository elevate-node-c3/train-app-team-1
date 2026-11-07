import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { GrpcCorrelationInterceptor } from '@app/common';
import {
  CATALOG_SERVICE_NAME,
  type GetTripStopsRequest,
  type SearchOneWayTripsRequest,
  type SearchOneWayTripsResponse,
  type SearchReturnTripsRequest,
  type SearchReturnTripsResponse,
  type TripStopsResponse,
} from '@app/contracts';

import { isCatalogSearchError } from './catalog-search-error.js';
import { TripReturnSearchService } from './trip-return-search.service.js';
import { TripSearchService } from './trip-search.service.js';
import { TripStopsService } from './trip-stops.service.js';

/**
 * Turns a refusal into a gRPC status.
 *
 * The business code travels in `details`, as identity's controller does it:
 * the status only tells a generic client how to categorise the failure, and
 * the gateway restores the code after validating it against the enum, so an
 * unknown string can never reach a traveller.
 *
 * The refusal carries only the code and the fields. The date strip and window
 * went with it for a while, so a client could re-render the picker beside the
 * error, but `ApiErrorDetail` has nowhere to put them and nothing at the edge
 * consumed them -- so they are not sent rather than sent and discarded.
 */
function toRpcException(error: unknown): unknown {
  if (!isCatalogSearchError(error)) return error;

  return new RpcException({
    code: grpc.status.INVALID_ARGUMENT,
    details: JSON.stringify({
      code: error.code,
      details: error.details,
    }),
    message: error.message,
  });
}

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class TripsGrpcController {
  constructor(
    private readonly search: TripSearchService,
    private readonly returnSearch: TripReturnSearchService,
    private readonly stops: TripStopsService,
  ) {}

  /**
   * `now` is captured here, once, and threaded through the whole search.
   *
   * The transport is the only honest place for it: a service that called
   * `new Date()` itself could not be tested against a frozen clock, and two
   * calls inside one request could disagree about whether a trip's sales are
   * still open.
   */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'SearchOneWayTrips')
  async searchOneWayTrips(
    request: SearchOneWayTripsRequest,
  ): Promise<SearchOneWayTripsResponse> {
    try {
      return await this.search.search(request, new Date());
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  /**
   * The second list of a round trip.
   *
   * `now` is captured here too, and for the same reason. The arrival that
   * bounds this list is NOT captured here: the service reads it from the trip
   * itself, so no clock and no client can move it.
   */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'SearchReturnTrips')
  async searchReturnTrips(
    request: SearchReturnTripsRequest,
  ): Promise<SearchReturnTripsResponse> {
    try {
      return await this.returnSearch.search(request, new Date());
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }

  /**
   * The stops of the pair the search result offered.
   *
   * No clock is captured: unlike search, this answer is not a function of
   * `now`. The cache TTL is the only time-dependent part, and it is chosen
   * inside the service.
   */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'GetTripStops')
  async getTripStops(request: GetTripStopsRequest): Promise<TripStopsResponse> {
    try {
      return await this.stops.stops(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
