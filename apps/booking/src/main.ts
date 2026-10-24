import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { commonEnvSchema, setupApp, validateEnv } from '@app/common';
import { getHealthProtoPath, HEALTH_PACKAGE_NAME } from '@app/contracts';
import { BookingModule } from './booking.module.js';

// 1. Fail-fast configuration validation at boot (§2.1)
validateEnv(commonEnvSchema, process.env, 'booking');

async function bootstrap() {
  const app = await NestFactory.create(BookingModule, { bufferLogs: true });

  const grpcPort = process.env.GRPC_PORT || 50051;
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: HEALTH_PACKAGE_NAME,
      protoPath: getHealthProtoPath(),
      url: `0.0.0.0:${grpcPort}`,
    },
  });

  await app.startAllMicroservices();
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('booking failed to start', error);
  process.exit(1);
});
