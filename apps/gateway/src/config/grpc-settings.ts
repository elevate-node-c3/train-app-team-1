/**
 * Startup validates gRPC URLs; tests may use defaults.
 * Read environment values only in config and app setup.
 */
export const DOWNSTREAM_SERVICES = [
  'catalog',
  'identity',
  'inventory',
  'booking',
  'payment',
  'notification',
] as const;

export type DownstreamService = (typeof DOWNSTREAM_SERVICES)[number];

const DEFAULT_GRPC_PORT = '50051';

export function identityGrpcUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return nonEmpty(env.IDENTITY_GRPC_URL) ?? `identity:${DEFAULT_GRPC_PORT}`;
}

export function downstreamGrpcUrlsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<DownstreamService, string> {
  const urls = {} as Record<DownstreamService, string>;
  for (const service of DOWNSTREAM_SERVICES) {
    const variable = `${service.toUpperCase()}_GRPC_URL`;
    urls[service] =
      nonEmpty(env[variable]) ?? `${service}:${DEFAULT_GRPC_PORT}`;
  }
  return urls;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
