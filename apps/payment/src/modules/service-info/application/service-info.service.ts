import { Injectable } from '@nestjs/common';

export interface ServiceInfo {
  service: string;
  status: string;
}

/**
 * No domain layer and no ports: this feature answers a constant and touches
 * nothing. Layers are added when there is something to put in them (ADR-0007).
 */
@Injectable()
export class ServiceInfoService {
  getInfo(): ServiceInfo {
    return { service: 'payment', status: 'operational' };
  }
}
