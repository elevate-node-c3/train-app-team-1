import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { CreateStationRequest, StationDetails } from '@app/contracts';
import { StationEntity } from './entities/station.entity.js';
import type {
  CityDto,
  GovernorateDto,
  StationCatalogDto,
} from './stations.types.js';

@Injectable()
export class StationsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findById(
    stationId: string,
    ctx?: TransactionContext,
  ): Promise<StationDetails | null> {
    const manager = ctx ? entityManagerOf(ctx) : this.dataSource.manager;
    const rows: (Omit<StationDetails, 'createdAt' | 'updatedAt'> & {
      createdAt: Date;
      updatedAt: Date;
    })[] = await manager.query(
      `
      SELECT s.id, s.city_id AS "cityId", c.governorate_id AS "governorateId",
        json_build_object('ar', s.name_ar, 'en', s.name_en) AS name,
        json_build_object('ar', c.name_ar, 'en', c.name_en) AS "cityName",
        json_build_object('ar', g.name_ar, 'en', g.name_en) AS "governorateName",
        s.alt_spellings AS "altSpellings", s.is_active AS "isActive",
        s.created_at AS "createdAt", s.updated_at AS "updatedAt"
      FROM station s JOIN city c ON c.id = s.city_id
      JOIN governorate g ON g.id = c.governorate_id
      WHERE s.id = $1 ${ctx ? 'FOR UPDATE OF s' : ''}
    `,
      [stationId],
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  }

  async cityExists(ctx: TransactionContext, cityId: string): Promise<boolean> {
    const rows: { id: string }[] = await entityManagerOf(ctx).query(
      'SELECT id FROM city WHERE id = $1 FOR KEY SHARE',
      [cityId],
    );
    return rows.length > 0;
  }

  async insert(
    ctx: TransactionContext,
    stationId: string,
    request: CreateStationRequest,
  ): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(StationEntity)
      .insert({
        id: stationId,
        cityId: request.cityId,
        nameAr: request.nameAr,
        nameEn: request.nameEn,
        altSpellings: request.altSpellings ?? [],
        isActive: request.isActive ?? true,
      });
  }

  async update(
    ctx: TransactionContext,
    station: StationDetails,
  ): Promise<void> {
    await entityManagerOf(ctx).getRepository(StationEntity).update(station.id, {
      cityId: station.cityId,
      nameAr: station.name.ar,
      nameEn: station.name.en,
      altSpellings: station.altSpellings,
      isActive: station.isActive,
    });
  }

  async findAllActive(): Promise<StationCatalogDto> {
    const rawRows: {
      gov_id: string;
      gov_name_ar: string;
      gov_name_en: string;
      gov_sort_order: number;
      city_id: string;
      city_name_ar: string;
      city_name_en: string;
      station_id: string;
      station_name_ar: string;
      station_name_en: string;
      station_alt_spellings: string[];
    }[] = await this.dataSource.query(`
      SELECT
        g.id AS gov_id,
        g.name_ar AS gov_name_ar,
        g.name_en AS gov_name_en,
        g.sort_order AS gov_sort_order,
        c.id AS city_id,
        c.name_ar AS city_name_ar,
        c.name_en AS city_name_en,
        s.id AS station_id,
        s.name_ar AS station_name_ar,
        s.name_en AS station_name_en,
        s.alt_spellings AS station_alt_spellings
      FROM governorate g
      JOIN city c ON c.governorate_id = g.id
      JOIN station s ON s.city_id = c.id
      WHERE s.is_active = true
      ORDER BY g.sort_order ASC, c.name_en ASC, s.name_en ASC
    `);

    const govMap = new Map<string, GovernorateDto>();
    const cityMap = new Map<string, CityDto>();

    for (const row of rawRows) {
      let gov = govMap.get(row.gov_id);
      if (!gov) {
        gov = {
          id: row.gov_id,
          name: { en: row.gov_name_en, ar: row.gov_name_ar },
          sortOrder: row.gov_sort_order,
          cities: [],
        };
        govMap.set(row.gov_id, gov);
      }

      let city = cityMap.get(row.city_id);
      if (!city) {
        city = {
          id: row.city_id,
          name: { en: row.city_name_en, ar: row.city_name_ar },
          stations: [],
        };
        cityMap.set(row.city_id, city);
        gov.cities.push(city);
      }

      city.stations.push({
        id: row.station_id,
        name: { en: row.station_name_en, ar: row.station_name_ar },
        altSpellings: row.station_alt_spellings ?? [],
      });
    }

    return { governorates: Array.from(govMap.values()) };
  }
}
