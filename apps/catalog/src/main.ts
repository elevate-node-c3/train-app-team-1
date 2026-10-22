import { NestFactory } from '@nestjs/core';
import { CatalogModule } from './catalog.module.js';

async function bootstrap() {
  const app = await NestFactory.create(CatalogModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((error: unknown) => {
  console.error('catalog failed to start', error);
  process.exit(1);
});
