import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type { EmailDeliveryRecord } from './email-delivery.types.js';
import { EmailDeliveryEntity } from './entities/email-delivery.entity.js';

type EmailDeliveryRow = Omit<EmailDeliveryEntity, 'createdAt'>;

/**
 * Append delivery records, including duplicate attempts; never store codes.
 * Initialize the shared database before the first event writes to it.
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
