import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { paymentDoubleSucceededBookingsFromEnv } from '../../config/payment-double.settings.js';
import type {
  CancelChargeRequest,
  CancelChargeResponse,
  StartChargeRequest,
  StartChargeResponse,
} from '@app/contracts';

interface ChargeRow {
  id: string;
  booking_reference: string;
  idempotency_key: string;
  amount_piastres: number;
  currency: string;
  status: 'started' | 'succeeded' | 'cancelled';
}

/**
 * Sprint 3 contract-compatible payment double. Stripe can replace this provider
 * in payment without changing the booking contract or client.
 */
@Injectable()
export class PaymentDoubleService {
  private readonly succeededBookings = paymentDoubleSucceededBookingsFromEnv();

  constructor(private readonly dataSource: DataSource) {}

  async start(request: StartChargeRequest): Promise<StartChargeResponse> {
    if (
      request.currency !== 'EGP' ||
      !Number.isInteger(request.amountPiastres) ||
      request.amountPiastres < 1
    ) {
      throw new RpcException({
        code: status.INVALID_ARGUMENT,
        message: 'Invalid charge request',
      });
    }

    await this.dataSource.query(
      `INSERT INTO payment_charge
         (id, booking_reference, idempotency_key, amount_piastres, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'started')
       ON CONFLICT DO NOTHING`,
      [
        uuid(),
        request.bookingReference,
        request.idempotencyKey,
        request.amountPiastres,
        request.currency,
      ],
    );
    const rows = (await this.dataSource.query(
      'SELECT * FROM payment_charge WHERE booking_reference = $1 OR idempotency_key = $2',
      [request.bookingReference, request.idempotencyKey],
    )) as ChargeRow[];
    const charge = rows[0];
    if (
      !charge ||
      charge.booking_reference !== request.bookingReference ||
      charge.idempotency_key !== request.idempotencyKey ||
      Number(charge.amount_piastres) !== request.amountPiastres
    ) {
      throw new RpcException({
        code: status.ALREADY_EXISTS,
        message: 'Payment idempotency key conflicts with an existing charge',
      });
    }

    if (this.succeededBookings.has(request.bookingReference)) {
      await this.dataSource.query(
        "UPDATE payment_charge SET status = 'succeeded' WHERE id = $1 AND status = 'started'",
        [charge.id],
      );
    }

    return {
      paymentReference: charge.id,
      status: this.succeededBookings.has(request.bookingReference)
        ? 'SUCCEEDED'
        : 'STARTED',
    };
  }

  async cancel(request: CancelChargeRequest): Promise<CancelChargeResponse> {
    const rows = (await this.dataSource.query(
      `UPDATE payment_charge
          SET status = 'cancelled'
        WHERE id = $1 AND booking_reference = $2 AND status = 'started'
        RETURNING status`,
      [request.paymentReference, request.bookingReference],
    )) as Array<{ status: string }>;
    if (rows[0]) return { status: 'CANCELLED' };

    const existing = (await this.dataSource.query(
      'SELECT status FROM payment_charge WHERE id = $1 AND booking_reference = $2',
      [request.paymentReference, request.bookingReference],
    )) as Array<{ status: string }>;
    if (existing[0]?.status === 'succeeded') {
      return { status: 'ALREADY_SUCCEEDED' };
    }
    if (existing[0]?.status === 'cancelled') {
      return { status: 'CANCELLED' };
    }
    throw new RpcException({
      code: status.NOT_FOUND,
      message: 'Charge not found',
    });
  }
}
