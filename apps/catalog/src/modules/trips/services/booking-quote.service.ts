import { Injectable } from '@nestjs/common';
import {
  cairoCivilDateOf,
  civilDateTimeOf,
  ErrorCode,
  FARE_CURRENCY,
  isWithinBookingWindow,
} from '@app/contracts';
import { DataSource } from 'typeorm';
import type {
  QuoteBookingRequest,
  QuoteBookingResponse,
  QuotedLeg,
  TravelClass,
} from '@app/contracts';
import { CatalogSearchError } from '../catalog-search-error.js';

interface QuoteRow {
  amount_piastres: number;
  train_number: number;
  train_type_en: string;
  train_type_ar: string;
  class_en: string;
  class_ar: string;
  origin_en: string;
  origin_ar: string;
  destination_en: string;
  destination_ar: string;
  departure_at: Date | string;
  arrival_at: Date | string;
}

/**
 * The authoritative fare of each leg's train, class and station pair, for one
 * passenger (BR-30). Booking stores it, so later fare changes never reach a
 * booking that is already priced.
 */
@Injectable()
export class BookingQuoteService {
  constructor(private readonly dataSource: DataSource) {}

  async quote(request: QuoteBookingRequest): Promise<QuoteBookingResponse> {
    if (request.legs.length === 0 || !request.travelClassId) {
      throw new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
        {
          field: 'legs',
          rejectedValue: request.legs.length,
          issueKey: 'ISSUE_LIST_TOO_SHORT',
        },
      ]);
    }

    const now = new Date();
    let travelClass: TravelClass | undefined;
    const legs: QuotedLeg[] = [];

    for (const [index, leg] of request.legs.entries()) {
      const rows = (await this.dataSource.query(
        `SELECT fa.amount_piastres, tr.train_number,
                tt.name_en AS train_type_en, tt.name_ar AS train_type_ar,
                tc.name_en AS class_en, tc.name_ar AS class_ar,
                os.name_en AS origin_en, os.name_ar AS origin_ar,
                ds.name_en AS destination_en, ds.name_ar AS destination_ar,
                o.departure_at, d.arrival_at
           FROM dated_trip t
           JOIN train tr ON tr.id = t.train_id
           JOIN train_type tt ON tt.id = tr.train_type_id
           JOIN trip_stop o ON o.trip_id = t.id
           JOIN trip_stop d ON d.trip_id = t.id
           JOIN station os ON os.id = o.station_id
           JOIN station ds ON ds.id = d.station_id
           JOIN fare fa ON fa.train_id = t.train_id
           JOIN travel_class tc ON tc.id = fa.travel_class_id
          WHERE t.id = $1
            AND t.status = 'published'
            AND o.station_id = $2
            AND d.station_id = $3
            AND d.position > o.position
            AND tc.id = $4
            AND fa.origin_station_id = o.station_id
            AND fa.destination_station_id = d.station_id
            AND fa.effective_from <= $5
            AND o.departure_at > $5
          ORDER BY fa.effective_from DESC
          LIMIT 1`,
        [
          leg.tripId,
          leg.originStationId,
          leg.destinationStationId,
          request.travelClassId,
          now,
        ],
      )) as QuoteRow[];

      const row = rows[0];
      const departureAt = row ? new Date(row.departure_at) : undefined;
      if (
        !row ||
        !departureAt ||
        !isWithinBookingWindow(cairoCivilDateOf(departureAt), now)
      ) {
        throw new CatalogSearchError(ErrorCode.SALES_CLOSED, [
          {
            field: `legs[${index}].tripId`,
            rejectedValue: leg.tripId,
            issueKey: 'ISSUE_SALES_CLOSED_FOR_TRAIN',
            actionKey: 'ACTION_PICK_ANOTHER_TRAIN',
          },
        ]);
      }

      travelClass ??= {
        id: request.travelClassId,
        name: { en: row.class_en, ar: row.class_ar },
      };
      legs.push({
        tripId: leg.tripId,
        trainNumber: Number(row.train_number),
        trainType: { en: row.train_type_en, ar: row.train_type_ar },
        departure: {
          stationId: leg.originStationId,
          name: { en: row.origin_en, ar: row.origin_ar },
          at: civilDateTimeOf(departureAt),
        },
        arrival: {
          stationId: leg.destinationStationId,
          name: { en: row.destination_en, ar: row.destination_ar },
          at: civilDateTimeOf(new Date(row.arrival_at)),
        },
        fare: {
          amountMinor: Number(row.amount_piastres),
          currency: FARE_CURRENCY,
        },
      });
    }

    return { travelClass: travelClass!, legs };
  }
}
