/**
 * Composition-root parsing. The value has already passed the Joi schema in
 * `main.ts`; the fallback keeps a host-run unit test or migration safe too.
 */
export function bcryptCostFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.BCRYPT_COST ?? 12);
  return Number.isInteger(configured) && configured >= 4 && configured <= 15
    ? configured
    : 12;
}
