import { NestFactory } from '@nestjs/core';
import { InventoryModule } from './inventory.module.js';

async function bootstrap() {
  const app = await NestFactory.create(InventoryModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
