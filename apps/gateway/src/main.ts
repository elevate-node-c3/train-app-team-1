import { NestFactory } from '@nestjs/core';
import { gatewayEnvSchema, setupApp, validateEnv } from '@app/common';
import { GatewayModule } from './gateway.module.js';

// 1. Fail-fast environment configuration validation at boot (§2.1)
validateEnv(gatewayEnvSchema, process.env, 'gateway');

async function bootstrap() {
  const app = await NestFactory.create(GatewayModule, { bufferLogs: true });
  setupApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  console.error('gateway failed to start', error);
  process.exit(1);
});
