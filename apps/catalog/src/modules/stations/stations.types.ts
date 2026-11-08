export interface StationDto {
  id: string;
  name: { en: string; ar: string };
  altSpellings: string[];
}

export interface CityDto {
  id: string;
  name: { en: string; ar: string };
  stations: StationDto[];
}

export interface GovernorateDto {
  id: string;
  name: { en: string; ar: string };
  sortOrder: number;
  cities: CityDto[];
}

export interface StationCatalogDto {
  governorates: GovernorateDto[];
}

