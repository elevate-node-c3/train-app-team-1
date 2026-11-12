/**
 * Can this identifier be safely passed to a PostgreSQL uuid column?
 * Accepts any hex-shaped UUID, including nil, without version/variant checks.
 */
export const UUID_SHAPE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this traveller-supplied identifier an RFC UUID (version 1-8, RFC variant)?
 * Rejects the nil UUID, unlike the database-safe shape check.
 */
export const RFC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidShape(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE_PATTERN.test(value);
}

export function isRfcUuid(value: unknown): value is string {
  return typeof value === 'string' && RFC_UUID_PATTERN.test(value);
}

/**
 * A UUID column rejects a malformed id with `22P02`, so filter to UUID shape
 * first or a typo becomes a 500 instead of an unknown-reference refusal.
 */
export function uuidShapedOnly(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_SHAPE_PATTERN.test(id)))];
}
