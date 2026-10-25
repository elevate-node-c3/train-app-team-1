import { NestFactory } from '@nestjs/core';
import { setupApp, validateEnv } from '@app/common';
import { gatewayEnvSchema } from './config/env.schema.js';
import { GatewayModule } from './gateway.module.js';

// 1. Fail-fast environment configuration validation at boot (§2.1)
validateEnv(gatewayEnvSchema, process.env, 'gateway');

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule, { bufferLogs: true });
  setupApp(app, { apiPrefix: 'api/v1' });
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('gateway failed to start', error);
  process.exit(1);
});
