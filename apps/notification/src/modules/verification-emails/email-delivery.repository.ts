import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type { EmailDeliveryRecord } from './email-delivery.types.js';
import { EmailDeliveryEntity } from './entities/email-delivery.entity.js';

type EmailDeliveryRow = Omit<EmailDeliveryEntity, 'createdAt'>;

/**
 * The delivery log is append-only: every attempt that reached the SMTP
 * crossing gets a row, because the BR-03 report counts what actually happened
 * over the wire rather than deduplicating it away (ADR-0003).
 *
 * The repository owns the union-to-row flattening. Keeping it here means the
 * nullable columns cannot be assembled correctly anywhere except in the file
 * that owns the table. The code is intentionally absent: there is no column it
 * could go in.
 *
 * `manualInitialization: true` means a broker delivery can arrive before any
 * other provider has touched the DataSource, so the first database access goes
 * through the shared initializer rather than a bare injected DataSource.
 */
@Injectable()
export class EmailDeliveryRepository {
  constructor(private readonly initializer: DataSourceInitializer) {}

  async record(delivery: EmailDeliveryRecord): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();
    await dataSource.getRepository(EmailDeliveryEntity).insert(toRow(delivery));
  }
}

function toRow(delivery: EmailDeliveryRecord): EmailDeliveryRow {
  const accepted = delivery.outcome === 'accepted' ? delivery : null;
  const skipped = delivery.outcome === 'skipped_expired' ? delivery : null;
  const failed = delivery.outcome === 'failed' ? delivery : null;

  return {
    id: randomUUID(),
    eventId: delivery.eventId,
    accountId: delivery.accountId,
    recipientEmail: delivery.recipientEmail,
    purpose: delivery.purpose,
    outcome: delivery.outcome,
    skipReason: skipped?.skipReason ?? null,
    issuedAt: delivery.issuedAt,
    acceptedAt: accepted?.acceptedAt ?? null,
    latencyMs: accepted?.latencyMs ?? null,
    errorMessage: failed?.errorMessage ?? null,
  };
}
