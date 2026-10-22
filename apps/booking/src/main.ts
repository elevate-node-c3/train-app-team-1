import { NestFactory } from '@nestjs/core';
import { BookingModule } from './booking.module.js';

async function bootstrap() {
  const app = await NestFactory.create(BookingModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('booking failed to start', error);
  process.exit(1);
});
