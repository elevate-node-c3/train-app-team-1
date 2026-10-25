import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  DependencyHealthRegistry,
  GracefulShutdownService,
  HealthService,
} from '@app/common';

describe('Health, Readiness & Degraded Operation (§2.3 rule 7, AUTH-1)', () => {
  describe('GracefulShutdownService', () => {
    it('reports live when not shutting down', () => {
      const shutdownService = new GracefulShutdownService();
      const healthService = new HealthService(shutdownService, {
        check: async () => ({ status: 'ready' }),
      } as any);

      const liveness = healthService.checkLiveness();
      expect(liveness.status).toBe('live');
    });

    it('rejects work and throws 503 during graceful shutdown', () => {
      const shutdownService = new GracefulShutdownService();
      const healthService = new HealthService(shutdownService, {
        check: async () => ({ status: 'ready' }),
      } as any);

      shutdownService.markShuttingDown();
      expect(shutdownService.isAcceptingRequests()).toBe(false);

      expect(() => healthService.checkLiveness()).toThrowError(
        ServiceUnavailableException,
      );
    });
  });

  describe('HealthService: Postgres and Redis degraded states', () => {
    it('returns ready when database and Redis are operational', async () => {
      const shutdownService = new GracefulShutdownService();
      const mockDataSource = {
        isInitialized: true,
        query: async () => [{ '?column?': 1 }],
      } as any;
      const mockRedisHealth = {
        check: async () => ({ status: 'ready' as const }),
      } as any;

      const healthService = new HealthService(
        shutdownService,
        mockRedisHealth,
        mockDataSource,
      );

      const report = await healthService.checkReadiness('identity');
      expect(report.status).toBe('ready');
      expect(report.dependencies.database.status).toBe('ready');
      expect(report.dependencies.redis.status).toBe('ready');
    });

    it('reports degraded when Redis is unavailable, but keeps HTTP 200 (not dead per §2.3 rule 7)', async () => {
      const shutdownService = new GracefulShutdownService();
      const mockDataSource = {
        isInitialized: true,
        query: async () => [{ '?column?': 1 }],
      } as any;
      const mockRedisHealth = {
        check: async () => ({
          status: 'unavailable' as const,
          message: 'Connection refused',
        }),
      } as any;

      const healthService = new HealthService(
        shutdownService,
        mockRedisHealth,
        mockDataSource,
      );

      const report = await healthService.checkReadiness('booking');
      // Must NOT throw 503; must return status: 'degraded'
      expect(report.status).toBe('degraded');
      expect(report.dependencies.database.status).toBe('ready');
      expect(report.dependencies.redis.status).toBe('degraded');
      expect(report.dependencies.redis.message).toBe('Connection refused');
    });

    it('includes a registered dependency and fails readiness when it is down', async () => {
      const mockDataSource = {
        isInitialized: true,
        query: async () => [{ '?column?': 1 }],
      } as any;
      const mockRedisHealth = {
        check: async () => ({ status: 'ready' as const }),
      } as any;

      // Silently losing this is the risk the registry introduces: a report that
      // never checked the broker still answers `ready`.
      const registry = new DependencyHealthRegistry();
      registry.register({
        name: 'broker',
        check: async () => ({ ready: false, message: 'Channel not open' }),
      });

      const healthService = new HealthService(
        new GracefulShutdownService(),
        mockRedisHealth,
        mockDataSource,
        undefined,
        registry,
      );

      await expect(
        healthService.checkReadiness('notification'),
      ).rejects.toThrowError(ServiceUnavailableException);

      registry.register({ name: 'broker', check: async () => ({ ready: true }) });
      const report = await healthService.checkReadiness('notification');
      expect(report.dependencies.broker.status).toBe('ready');
    });

    it('throws ServiceUnavailableException (503) when Postgres database is down', async () => {
      const shutdownService = new GracefulShutdownService();
      const mockDataSource = {
        isInitialized: true,
        query: async () => {
          throw new Error('Connection terminated unexpectedly');
        },
      } as any;
      const mockRedisHealth = {
        check: async () => ({ status: 'ready' as const }),
      } as any;

      const healthService = new HealthService(
        shutdownService,
        mockRedisHealth,
        mockDataSource,
      );

      await expect(
        healthService.checkReadiness('catalog'),
      ).rejects.toThrowError(ServiceUnavailableException);
    });
  });
});
