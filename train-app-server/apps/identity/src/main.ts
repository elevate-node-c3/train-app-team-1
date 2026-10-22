import { NestFactory } from '@nestjs/core';
import { IdentityModule } from './identity.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IdentityModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
