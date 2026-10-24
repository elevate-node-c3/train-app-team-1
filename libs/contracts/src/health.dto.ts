import { getProtoPath } from './proto-path.js';

export type HealthState = 'ready' | 'not_ready' | 'degraded' | 'down';

export interface ServiceDependencyHealth {
  status: HealthState;
  message?: string;
}

export interface ServiceHealthReport {
  service: string;
  status: HealthState;
  dependencies: Record<string, ServiceDependencyHealth>;
  timestamp: string;
}

export interface AggregatedHealthReport {
  status: HealthState;
  gateway: ServiceHealthReport;
  services: Record<string, ServiceHealthReport>;
  timestamp: string;
}

/** Resolves the absolute path to health.proto across dev and build environments. */
export function getHealthProtoPath(): string {
  return getProtoPath('health.proto');
}

export const HEALTH_PACKAGE_NAME = 'train.health.v1';
export const HEALTH_SERVICE_NAME = 'HealthService';
