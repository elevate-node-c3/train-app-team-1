import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { commonEnvSchema, setupApp, validateEnv } from '@app/common';
import {
  CATALOG_PACKAGE_NAME,
  getCatalogProtoPath,
  getHealthProtoPath,
  HEALTH_PACKAGE_NAME,
} from '@app/contracts';
import { CatalogModule } from './catalog.module.js';
import { warnIfStripeFloorUnconfigured } from './config/operations-settings.js';

// 1. Fail-fast configuration validation at boot (§2.1)
validateEnv(commonEnvSchema, process.env, 'catalog');

async function bootstrap() {
  const app = await NestFactory.create(CatalogModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  // Both proto packages share one server. Arrays are the supported Nest shape;
  // two connectMicroservice calls on the same port would fight for the socket.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, CATALOG_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getCatalogProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
      // Matches the gateway's loader, so an enum is a name on both sides and a
      // repeated field is always an array. See that module for the measured
      // behaviour behind these two, and why `defaults` is not among them.
      loader: { enums: String, arrays: true },
    },
  });

  await app.startAllMicroservices();
  setupApp(app);
  warnIfStripeFloorUnconfigured(app.get(Logger));
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('catalog failed to start', error);
  process.exit(1);
});
