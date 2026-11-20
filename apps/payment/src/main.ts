import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { setupApp, validateEnv } from '@app/common';
import {
  getHealthProtoPath,
  getPaymentProtoPath,
  HEALTH_PACKAGE_NAME,
  PAYMENT_PACKAGE_NAME,
} from '@app/contracts';
import { paymentEnvSchema } from './config/env.schema.js';
import { PaymentModule } from './payment.module.js';

validateEnv(paymentEnvSchema, process.env, 'payment');

async function bootstrap() {
  const app = await NestFactory.create(PaymentModule, {
    bufferLogs: true,
    rawBody: true,
  });

  const grpcPort = process.env.GRPC_PORT || 50051;
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: [HEALTH_PACKAGE_NAME, PAYMENT_PACKAGE_NAME],
      protoPath: [getHealthProtoPath(), getPaymentProtoPath()],
      url: `0.0.0.0:${grpcPort}`,
    },
  });

  await app.startAllMicroservices();
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('payment failed to start', error);
  process.exit(1);
});
