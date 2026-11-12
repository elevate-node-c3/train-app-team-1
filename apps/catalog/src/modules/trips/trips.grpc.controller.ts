import { Controller, UseInterceptors } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { CALLER_ACCOUNT_ID_KEY, GrpcCorrelationInterceptor } from '@app/common';
import { ClsService } from 'nestjs-cls';
import {
  CATALOG_SERVICE_NAME,
  type GetTripStopsRequest,
  type SearchOneWayTripsRequest,
  type SearchOneWayTripsResponse,
  type SearchReturnTripsRequest,
  type SearchReturnTripsResponse,
  type TripStopsResponse,
} from '@app/contracts';

import { TripReturnSearchService } from './trip-return-search.service.js';
import { TripSearchService } from './trip-search.service.js';
import { TripStopsService } from './trip-stops.service.js';
import { toRpcException } from './to-rpc-exception.js';

@Controller()
@UseInterceptors(GrpcCorrelationInterceptor)
export class TripsGrpcController {
  constructor(
    private readonly search: TripSearchService,
    private readonly returnSearch: TripReturnSearchService,
    private readonly stops: TripStopsService,
    private readonly cls: ClsService,
  ) {}

  /**
   * `now` is captured here, once, and threaded through the whole search.
   *
   * The transport is the only honest place for it: a service that called
   * `new Date()` itself could not be tested against a frozen clock, and two
   * calls inside one request could disagree about whether a trip's sales are
   * still open.
   *
   * The traveller comes from the same place, for the same reason -- caller
   * metadata the gateway minted from a verified token, never a field on the
   * request. It is only used to record the search; an unidentified caller
   * still gets results, because they are identical for everyone.
   */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'SearchOneWayTrips')
  async searchOneWayTrips(
    request: SearchOneWayTripsRequest,
  ): Promise<SearchOneWayTripsResponse> {
    try {
      return await this.search.search(
        request,
        new Date(),
        this.cls.get<string>(CALLER_ACCOUNT_ID_KEY) ?? null,
      );
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
