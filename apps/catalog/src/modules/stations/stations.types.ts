import type { LocalizedName } from '@app/contracts';

export interface StationDto {
  id: string;
  name: LocalizedName;
  altSpellings: string[];
}

export interface CityDto {
  id: string;
  name: LocalizedName;
  stations: StationDto[];
}

export interface GovernorateDto {
  id: string;
  name: LocalizedName;
  sortOrder: number;
  cities: CityDto[];
}

export interface StationCatalogDto {
  governorates: GovernorateDto[];
}
