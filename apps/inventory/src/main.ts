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

// 1. Fail-fast configuration validation at boot (§2.1)
validateEnv(commonEnvSchema, process.env, 'inventory');

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  // Both proto packages share one server. Arrays are the supported Nest shape;
  // two connectMicroservice calls on the same port would fight for the socket.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, INVENTORY_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getInventoryProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
      // Matches catalog and the gateway, so an enum is a name on both sides
      // and a repeated field is always an array -- catalog is this rpc's
      // client and the two sides must agree on `repeated` handling.
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
