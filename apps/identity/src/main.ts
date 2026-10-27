import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { setupApp, validateEnv } from '@app/common';
import { identityEnvSchema } from './config/env.schema.js';
import {
  IDENTITY_PACKAGE_NAME,
  HEALTH_PACKAGE_NAME,
  getIdentityProtoPath,
  getHealthProtoPath,
} from '@app/contracts';
import { IdentityModule } from './identity.module.js';

// 1. Fail-fast configuration validation at boot (§2.1)
validateEnv(identityEnvSchema, process.env, 'identity');

async function bootstrap() {
  const app = await NestFactory.create(IdentityModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  // Both proto packages share one server. Arrays are the supported Nest shape;
  // two connectMicroservice calls on the same port would fight for the socket.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, IDENTITY_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getIdentityProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
    },
  });

  await app.startAllMicroservices();
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('identity failed to start', error);
  process.exit(1);
});
