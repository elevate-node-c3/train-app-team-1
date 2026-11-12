import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { commonEnvSchema, setupApp, validateEnv } from '@app/common';
import {
  getHealthProtoPath,
  getInventoryProtoPath,
  HEALTH_PACKAGE_NAME,
  INVENTORY_PACKAGE_NAME,
} from '@app/contracts';
import { InventoryModule } from './inventory.module.js';

validateEnv(commonEnvSchema, process.env, 'inventory');

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
