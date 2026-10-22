import { NestFactory } from '@nestjs/core';
import { NotificationModule } from './notification.module.js';

async function bootstrap() {
  const app = await NestFactory.create(NotificationModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('notification failed to start', error);
  process.exit(1);
});
