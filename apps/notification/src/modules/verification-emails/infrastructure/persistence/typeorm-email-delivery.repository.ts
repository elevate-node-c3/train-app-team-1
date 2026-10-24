import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type {
  EmailDeliveryRecord,
  EmailDeliveryRepositoryPort,
} from '../../application/ports/email-delivery.repository.port.js';
import { INSERT_EMAIL_DELIVERY_SQL } from './email-delivery.sql.js';

/**
 * Raw SQL on purpose: this table is an append-only measurement record, not an
 * aggregate. The outcome union in the port is what keeps its nullable columns
 * internally consistent; the database CHECK is the second line of defence.
 */
@Injectable()
export class TypeOrmEmailDeliveryRepository implements EmailDeliveryRepositoryPort {
  constructor(private readonly initializer: DataSourceInitializer) {}

  async record(delivery: EmailDeliveryRecord): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();
    const accepted = delivery.outcome === 'accepted' ? delivery : null;
    const skipped = delivery.outcome === 'skipped_expired' ? delivery : null;
    const failed = delivery.outcome === 'failed' ? delivery : null;

    await dataSource.query(INSERT_EMAIL_DELIVERY_SQL, [
      randomUUID(),
      delivery.eventId,
      delivery.accountId,
      delivery.recipientEmail,
      delivery.purpose,
      delivery.outcome,
      skipped?.skipReason ?? null,
      delivery.issuedAt,
      accepted?.acceptedAt ?? null,
      accepted?.latencyMs ?? null,
      failed?.errorMessage ?? null,
    ]);
  }
}
