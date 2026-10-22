import { NestFactory } from '@nestjs/core';
import { MyAppModule } from './api_gateway.module.js';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import path from 'node:path';

/**
 * REQUEST FLOW
 * 1: request being authenticated by guards by 3 layers [token verification , revoked tokens , wrapping user data with the request]
 * 2: request being authorized by guards check access role for every end-point
 * 3: setting an interceptor before request reach to the controller that:
 *    A- monitor the request timeout
 *    B- monitor the request fail and succeed
 * 4: controller request from a service
 */

async function bootstrap() {
  const app = await NestFactory.create(MyAppModule);
  await NestFactory.createMicroservice<MicroserviceOptions>(MyAppModule, {
    transport: Transport.GRPC,
    options: {
      package: ['Booking', 'Catalog', ' Identity', 'Inventory'],
      protoPath: [
        path.join(import.meta.dirname, '../../../libs/protos/booking.proto'),
        path.join(import.meta.dirname, '../../../libs/protos/catalog.proto'),
        path.join(import.meta.dirname, '../../../libs/protos/identity.proto'),
        path.join(import.meta.dirname, '../../../libs/protos/inventory.proto'),
      ],
    },
  });
  await app.startAllMicroservices();
  app.enableCors();
  app.setGlobalPrefix('/api/v1');

  const config = new ConfigService();
  const port = config.get<string>('PORT');
  await app
    .listen(port ?? 3001)
    .then(() => console.log(`the api gateway run on port::${port}`));
}
bootstrap();
