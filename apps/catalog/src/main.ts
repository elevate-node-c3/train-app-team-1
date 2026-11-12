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

validateEnv(commonEnvSchema, process.env, 'catalog');

async function bootstrap() {
  const app = await NestFactory.create(CatalogModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  // Share one server to avoid binding the same port twice.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, CATALOG_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getCatalogProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
      // Match the gateway's enum and repeated-field shapes; omit scalar defaults.
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
