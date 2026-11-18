import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { setupApp, validateEnv } from '@app/common';
import {
  getHealthProtoPath,
  getInventoryProtoPath,
  HEALTH_PACKAGE_NAME,
  INVENTORY_PACKAGE_NAME,
} from '@app/contracts';
import { InventoryModule } from './inventory.module.js';
import { inventoryEnvSchema } from './config/inventory-env.schema.js';

const settings = validateEnv(inventoryEnvSchema, process.env, 'inventory');
// Apply validated non-secret flags and Inventory's measured relay settings.
for (const key of [
  'HOLD_CREATION_ENABLED',
  'HOLD_EXPIRY_WORKER_ENABLED',
  'HOLD_EXPIRY_BATCH_SIZE',
  'HOLD_EXPIRY_POLL_INTERVAL_MS',
  'OUTBOX_RELAY_ENABLED',
  'OUTBOX_BATCH_SIZE',
  'OUTBOX_POLL_INTERVAL_MS',
  'OUTBOX_PUBLISH_CONCURRENCY',
  'AMQP_PUBLISH_CONFIRM_TIMEOUT_MS',
]) {
  process.env[key] = String(settings[key]);
}

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  // Share one gRPC server to avoid binding the port twice.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, INVENTORY_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getInventoryProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
      // Match catalog and gateway: string enums and arrays for repeated fields.
      loader: { enums: String, arrays: true },
    },
  });

  await app.startAllMicroservices();
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('inventory failed to start', error);
  process.exit(1);
});
