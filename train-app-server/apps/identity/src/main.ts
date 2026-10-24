import { NestFactory } from '@nestjs/core';
import { IdentityModule } from './identity.module.js';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(IdentityModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}


bootstrap();