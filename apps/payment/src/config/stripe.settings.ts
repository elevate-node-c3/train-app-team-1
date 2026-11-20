export interface StripeSettings {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
}

export function stripeSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): StripeSettings {
  return {
    secretKey: env.STRIPE_SECRET_KEY ?? '',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? env.PUBLISHABLE_KEY ?? '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
  };
}
