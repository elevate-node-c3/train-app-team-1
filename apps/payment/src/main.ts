import { NestFactory } from '@nestjs/core';
import { PaymentModule } from './payment.module.js';

async function bootstrap() {
  const app = await NestFactory.create(PaymentModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('payment failed to start', error);
  process.exit(1);
});
