import { NestFactory } from '@nestjs/core';
import { IdentityModule } from './identity.module.js';

async function bootstrap() {
  const app = await NestFactory.create(IdentityModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('identity failed to start', error);
  process.exit(1);
});
