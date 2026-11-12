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
   * Capture now once per request so validation and sales checks share one clock.
   * Read traveller identity from gateway-verified metadata, never request fields.
   * Identity affects recording only; unidentified callers get the same results.
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
   * Capture now once; the service reads outbound arrival from the trip itself.
   * Client input and the clock must not move that arrival bound.
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

  /** Stops do not depend on now; the service chooses their cache TTL. */
  @GrpcMethod(CATALOG_SERVICE_NAME, 'GetTripStops')
  async getTripStops(request: GetTripStopsRequest): Promise<TripStopsResponse> {
    try {
      return await this.stops.stops(request);
    } catch (error: unknown) {
      throw toRpcException(error);
    }
  }
}
