import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import { RpcException } from '@nestjs/microservices';
import { CatalogSearchError } from '../trips/catalog-search-error.js';
import { StationsGrpcController } from './stations.grpc.controller.js';
import { StationsService } from './stations.service.js';
import type { StationsRepository } from './stations.repository.js';

describe('StationsGrpcController', () => {
  it('forwards language and query to the shared catalog service', async () => {
    const response = { governorates: [] };
    const listStationGroups = vi.fn(async () => response);
    const controller = new StationsGrpcController({
      listStationGroups,
    } as unknown as StationsService);
    expect(
      await controller.listStations({ language: 'en', query: 'Ramses' }),
    ).toBe(response);
    expect(listStationGroups).toHaveBeenCalledWith('en', 'Ramses');
  });

  it.each([
    {
      language: 'fr',
      query: '',
      field: 'language',
      issueKey: 'ISSUE_STATION_LANGUAGE_INVALID',
    },
    {
      language: 'en',
      query: 'a'.repeat(101),
      field: 'query',
      issueKey: 'ISSUE_STATION_QUERY_TOO_LONG',
    },
  ])(
    'uses the shared RPC refusal encoder for $field',
    async ({ language, query, field, issueKey }) => {
      const repository = { findAllActive: vi.fn() };
      const controller = new StationsGrpcController(
        new StationsService(repository as unknown as StationsRepository),
      );
      const error = await controller
        .listStations({ language, query })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        code: number;
        details: string;
      };
      const decoded = JSON.parse(payload.details);
      expect(payload.code).toBe(3);
      expect(decoded).toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        details: [
          {
            field,
            rejectedValue: field === 'query' ? query : language,
            issueKey,
          },
        ],
      });
      expect(decoded.details[0]).not.toHaveProperty('issue');
      expect(decoded.details[0]).not.toHaveProperty('action');
      expect(repository.findAllActive).not.toHaveBeenCalled();
    },
  );

  it('does not reimplement mapping for other catalog refusals', async () => {
    const refusal = new CatalogSearchError(ErrorCode.CONFLICT, []);
    const controller = new StationsGrpcController({
      listStationGroups: vi.fn().mockRejectedValue(refusal),
    } as unknown as StationsService);
    const error = await controller
      .listStations({ language: 'ar' })
      .catch((caught: unknown) => caught);
    const payload = (error as RpcException).getError() as { details: string };
    expect(JSON.parse(payload.details).code).toBe(ErrorCode.CONFLICT);
  });
});
