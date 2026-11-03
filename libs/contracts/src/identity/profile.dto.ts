import type { TokenPairDto } from './token-contract.js';

export interface CompleteProfileRequestDto {
  fullName: string;
  phoneNumber: string;
  nationalId: string;
  profileType: string;
  nationality: string;
}

export interface ProfileResponseDto {
  accountId: string;
  fullName: string | null;
  phoneNumber: string | null;
  nationalId: string | null;
  profileType: string | null;
  nationality: string | null;
  bookable: boolean;
}

export interface CompleteProfileResponseDto {
  tokens: TokenPairDto;
  profile: ProfileResponseDto;
}

export interface ProfileTypeDto {
  code: string;
  nameAr: string;
  nameEn: string;
}

export interface NationalityDto {
  code: string;
  nameAr: string;
  nameEn: string;
}

export interface ProfileOptionsResponseDto {
  profileTypes: ProfileTypeDto[];
  nationalities: NationalityDto[];
}

