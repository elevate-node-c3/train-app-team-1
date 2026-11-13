/** Startup validates this value; the fallback also supports tests and migrations. */
export function bcryptCostFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.BCRYPT_COST ?? 12);
  return Number.isInteger(configured) && configured >= 4 && configured <= 15
    ? configured
    : 12;
}
