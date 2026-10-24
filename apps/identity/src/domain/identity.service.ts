import { Injectable } from '@nestjs/common';
import { IdentityRepository } from '../persistence/identity.repository.js';

@Injectable()
export class IdentityService {
  constructor(private readonly repository: IdentityRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'identity',
      status: 'operational',
    };
  }
}
