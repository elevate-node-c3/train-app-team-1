import { Injectable } from '@nestjs/common';

export interface ServiceInfo {
  service: string;
  version: string;
  description: string;
}

/**
 * No domain layer and no ports: this feature answers a constant and touches
 * nothing. Layers are added when there is something to put in them (ADR-0007).
 */
@Injectable()
export class ServiceInfoService {
  getInfo(): ServiceInfo {
    return {
      service: 'gateway',
      version: '0.0.1',
      description: 'API Gateway for train reservation platform',
    };
  }
}
