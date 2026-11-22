import { createServer, type AddressInfo } from 'node:net';
import type { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import { ClsModule, ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';
import {
  DataSourceInitializer,
  GrpcCorrelationInterceptor,
  MigrationRunnerService,
  SchemaReadinessGate,
} from '@app/common';
import {
  getInventoryProtoPath,
  getPaymentProtoPath,
  INVENTORY_PACKAGE_NAME,
  INVENTORY_SERVICE_NAME,
  PAYMENT_PACKAGE_NAME,
  type SettlementSnapshot,
} from '@app/contracts';
import type { InventoryFlowClient } from '../../../apps/booking/src/modules/flow/flow-clients.types.js';
import { INVENTORY_GRPC_LOADER_OPTIONS } from '../../../apps/booking/src/modules/draft/booking-draft.module.js';
import { SeatHoldGrpcController } from '../../../apps/inventory/src/modules/seat-hold/seat-hold.grpc.controller.js';
import { HoldCoreService } from '../../../apps/inventory/src/modules/seat-hold/services/hold-core.service.js';
import { HoldSettlementService } from '../../../apps/inventory/src/modules/seat-hold/services/hold-settlement.service.js';
import {
  HoldCreationGuard,
  HoldServiceGuard,
} from '../../../apps/inventory/src/modules/seat-hold/hold-access.guard.js';
import { PaymentGrpcController } from '../../../apps/payment/src/modules/charges/payment.grpc.controller.js';
import { PaymentDoubleService } from '../../../apps/payment/src/modules/charges/services/payment-double.service.js';
import {
  inventoryHoldServiceFor,
  inventorySettlementFor,
  paymentServiceFor,
} from './booking-confirmation-fixture.js';

async function freeAddress(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return `127.0.0.1:${port}`;
}

export async function confirmationGrpcFixture(
  inventorySource: DataSource,
  paymentSource: DataSource,
) {
  const apps: INestMicroservice[] = [];
  const settlement = inventorySettlementFor(inventorySource);
  const settle = settlement.settle.bind(settlement);
  const receipts: { bookingId: string; snapshot: SettlementSnapshot }[] = [];
  let loss:
    | {
        bookingId: string;
        committed: (snapshot: SettlementSnapshot) => void;
        held: Promise<void>;
      }
    | undefined;
  let releaseLost: (() => void) | undefined;
  settlement.settle = async (request, correlationId) => {
    const result = await settle(request, correlationId);
    receipts.push({
      bookingId: request.bookingKey,
      snapshot: structuredClone(result),
    });
    if (loss?.bookingId === request.bookingKey) {
      const fault = loss;
      loss = undefined;
      fault.committed(result);
      // Real gRPC deadline expires after commit, while no response is delivered.
      // The test releases this promise after observing the worker's durable retry.
      await fault.held;
    }
    return result;
  };

  // Vitest and the subprocess compile separately. Explicit controller metadata
  // keeps test bootstrap independent of Vitest's decorator metadata transform.
  Reflect.defineMetadata(
    'design:paramtypes',
    [HoldCoreService, HoldSettlementService, ClsService],
    SeatHoldGrpcController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [PaymentDoubleService],
    PaymentGrpcController,
  );
  Reflect.defineMetadata(
    'design:paramtypes',
    [ClsService],
    GrpcCorrelationInterceptor,
  );

  const inventoryUrl = await freeAddress();
  const paymentUrl = await freeAddress();
  const initializer = new DataSourceInitializer(inventorySource);
  const inventoryModule = await Test.createTestingModule({
    imports: [ClsModule.forRoot()],
    controllers: [SeatHoldGrpcController],
    providers: [
      {
        provide: HoldCoreService,
        useValue: inventoryHoldServiceFor(inventorySource),
      },
      { provide: HoldSettlementService, useValue: settlement },
      { provide: DataSourceInitializer, useValue: initializer },
      { provide: SchemaReadinessGate, useValue: new SchemaReadinessGate() },
      { provide: MigrationRunnerService, useValue: { hasCompleted: true } },
      HoldServiceGuard,
      HoldCreationGuard,
    ],
  }).compile();
  const inventoryApp = inventoryModule.createNestMicroservice({
    transport: Transport.GRPC,
    logger: false,
    options: {
      url: inventoryUrl,
      package: INVENTORY_PACKAGE_NAME,
      protoPath: getInventoryProtoPath(),
      loader: INVENTORY_GRPC_LOADER_OPTIONS,
    },
  });
  apps.push(inventoryApp);
  const paymentModule = await Test.createTestingModule({
    imports: [ClsModule.forRoot()],
    controllers: [PaymentGrpcController],
    providers: [
      {
        provide: PaymentDoubleService,
        useValue: paymentServiceFor(paymentSource),
      },
    ],
  }).compile();
  const paymentApp = paymentModule.createNestMicroservice({
    transport: Transport.GRPC,
    logger: false,
    options: {
      url: paymentUrl,
      package: PAYMENT_PACKAGE_NAME,
      protoPath: getPaymentProtoPath(),
    },
  });
  apps.push(paymentApp);
  try {
    await Promise.all(apps.map((app) => app.listen()));
  } catch {
    await Promise.all(apps.map((app) => app.close()));
    throw new Error('Confirmation gRPC fixture bootstrap failed.');
  }
  const inventoryClient = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      url: inventoryUrl,
      package: INVENTORY_PACKAGE_NAME,
      protoPath: getInventoryProtoPath(),
      loader: INVENTORY_GRPC_LOADER_OPTIONS,
    },
  });
  return {
    inventoryUrl,
    paymentUrl,
    receipts,
    inventoryClient: (
      inventoryClient as unknown as ClientGrpc
    ).getService<InventoryFlowClient>(INVENTORY_SERVICE_NAME),
    loseNextSettlementResponse(bookingId: string) {
      if (loss || releaseLost)
        throw new Error('A settlement response fault is already armed.');
      let committed!: (snapshot: SettlementSnapshot) => void;
      const committedPromise = new Promise<SettlementSnapshot>((resolve) => {
        committed = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseLost = resolve;
      });
      loss = { bookingId, committed, held };
      return {
        committed: committedPromise,
        release: () => {
          releaseLost?.();
          releaseLost = undefined;
          loss = undefined;
        },
      };
    },
    close: async () => {
      releaseLost?.();
      inventoryClient.close();
      await Promise.all(apps.map((app) => app.close()));
    },
  };
}
