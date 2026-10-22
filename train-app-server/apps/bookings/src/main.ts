import { NestFactory } from '@nestjs/core';
import { BookingsModule } from './bookings.module.js';

async function bootstrap() {
  const app = await NestFactory.create(BookingsModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
