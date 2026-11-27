import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';

import { TicketEntity } from '../entities/ticket.entity.js';
import { isIssued, type IssuedTicket } from '../../tickets/ticket-view.js';

/**
 * The write path for cancelling a ticket. Reads are guarded by owner and
 * status; the single conditional UPDATE is what makes cancellation once-only.
 */
@Injectable()
export class TicketCancellationRepository {
  constructor(
    @InjectRepository(TicketEntity)
    private readonly tickets: Repository<TicketEntity>,
  ) {}

  /** A voided or unissued ticket cannot be cancelled or replayed. */
  findOwnedActiveOrCancelled(
    ticketId: string,
    ownerId: string,
  ): Promise<IssuedTicket | null> {
    return this.find({
      id: ticketId,
      ownerId,
      status: In(['active', 'cancelled']),
    });
  }

  /**
   * The cancel-once guard: the row changes only while it is still active.
   * A concurrent winner leaves no row, so no event can be appended for it.
   */
  async tryCancel(
    ctx: TransactionContext,
    input: {
      ticketId: string;
      ownerId: string;
      refundPiastres: number;
      idempotencyKey: string;
    },
  ): Promise<IssuedTicket | null> {
    const manager = entityManagerOf(ctx);
    const rows = await manager.query(
      `UPDATE ticket
          SET status = 'cancelled',
              status_reason = 'TRAVELLER_CANCELLED',
              status_changed_at = now(),
              refund_status = 'pending',
              refund_piastres = $3,
              cancellation_idempotency_key = $4
        WHERE id = $1 AND owner_id = $2 AND status = 'active'
        RETURNING id`,
      [
        input.ticketId,
        input.ownerId,
        input.refundPiastres,
        input.idempotencyKey,
      ],
    );
    if (unwrap(rows).length === 0) return null;

    const updated = await manager
      .getRepository(TicketEntity)
      .findOne({ where: { id: input.ticketId } });
    return isIssued(updated) ? updated : null;
  }

  /** The stored response of a cancellation already made with this key. */
  findByIdempotencyKey(
    ticketId: string,
    idempotencyKey: string,
  ): Promise<IssuedTicket | null> {
    return this.find({
      id: ticketId,
      cancellationIdempotencyKey: idempotencyKey,
    });
  }

  private async find(
    where: Record<string, unknown>,
  ): Promise<IssuedTicket | null> {
    const ticket = await this.tickets.findOne({ where });
    return isIssued(ticket) ? ticket : null;
  }
}

/** pg returns [rows, count] for UPDATE ... RETURNING through TypeORM. */
function unwrap(result: unknown): unknown[] {
  if (!Array.isArray(result)) return [];
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as unknown[];
  }
  return result as unknown[];
}
