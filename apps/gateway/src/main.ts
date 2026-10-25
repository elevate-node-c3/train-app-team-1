import { NestFactory } from '@nestjs/core';
import { gatewayEnvSchema, setupApp, validateEnv } from '@app/common';
import { GatewayModule } from './gateway.module.js';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import { RequestInterceptor } from './common/interceptors/global.interceptor.js';

validateEnv(gatewayEnvSchema, process.env, 'gateway');

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule, { bufferLogs: true });
  // await NestFactory.createMicroservice<MicroserviceOptions>(GatewayModule, {
  //   transport: Transport.GRPC,
  //   options: {
  //     protoPath: [path.join(import.meta.dirname, 'hero/hero.proto')],
  //     package: ['Identity'],
  //   },
  // });
  // app.startAllMicroservices();
  const config = new ConfigService();
  const port = config.get<string>('PORT') ?? 8080;
  setupApp(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalInterceptors(new RequestInterceptor());
  await app
    .listen(port)
    .then(() => console.log(`server is listening on port ${port}`));
}

bootstrap().catch((error: unknown) => {
  console.error('gateway failed to start', error);
  process.exit(1);
});
