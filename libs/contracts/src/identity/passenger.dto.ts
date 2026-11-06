export interface PassengerDto {
  id: string;
  fullName: string;
  nationalId: string;
  profileType: string;
  typeName: string;
  isSelf: boolean;
  createdAt: string;
}

export interface ListPassengersResponseDto {
  passengers: PassengerDto[];
}

export interface CreatePassengerRequestDto {
  fullName: string;
  nationalId: string;
  profileType: string;
}

export interface UpdatePassengerRequestDto {
  fullName: string;
  nationalId: string;
  profileType: string;
}
