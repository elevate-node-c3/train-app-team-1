import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { OperationsRequestEntity } from './entities/operations-request.entity.js';
import type { StoredOperationsRequest } from './operations-request.types.js';

/** Record keys in the caller's transaction so they commit with their changes. */
@Injectable()
export class OperationsRequestRepository {
  constructor(private readonly dataSource: DataSource) {}

  async find(idempotencyKey: string): Promise<StoredOperationsRequest | null> {
    const row = await this.dataSource
      .getRepository(OperationsRequestEntity)
      .findOne({ where: { idempotencyKey } });
    if (!row) return null;

    return {
      idempotencyKey: row.idempotencyKey,
      fingerprint: row.fingerprint,
      responseJson: row.responseJson,
    };
  }

  async record(
    ctx: TransactionContext,
    request: StoredOperationsRequest,
  ): Promise<void> {
    const repository = entityManagerOf(ctx).getRepository(
      OperationsRequestEntity,
    );
    const entity = new OperationsRequestEntity();
    entity.idempotencyKey = request.idempotencyKey;
    entity.fingerprint = request.fingerprint;
    entity.responseJson = request.responseJson;
    // INSERT rejects reused keys; save would silently overwrite them.
    await repository.insert(entity);
  }
}

/**
 * SHA-256 of `payload`, stable across key order. Array order is preserved:
 * stops are an ordered list. An `undefined` value matches an absent key.
 */
export function fingerprintOf(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedKeys(payload)))
    .digest('hex');
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortedKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
