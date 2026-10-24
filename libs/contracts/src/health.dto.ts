import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

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

/** Resolves the absolute path to health.proto across dev and build environments */
export function getHealthProtoPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // 1. Direct path in libs/contracts/src/proto/health.proto
  const candidate1 = join(currentDir, 'proto', 'health.proto');
  if (existsSync(candidate1)) return candidate1;

  // 2. Dist path relative to current module
  const candidate2 = join(currentDir, '..', 'proto', 'health.proto');
  if (existsSync(candidate2)) return candidate2;

  // 3. Root directory relative path
  const candidate3 = join(
    process.cwd(),
    'libs',
    'contracts',
    'src',
    'proto',
    'health.proto',
  );
  if (existsSync(candidate3)) return candidate3;

  const candidate4 = join(
    process.cwd(),
    'dist',
    'libs',
    'contracts',
    'src',
    'proto',
    'health.proto',
  );
  if (existsSync(candidate4)) return candidate4;

  return candidate1;
}

export const HEALTH_PACKAGE_NAME = 'train.health.v1';
export const HEALTH_SERVICE_NAME = 'HealthService';
