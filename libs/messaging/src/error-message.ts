/** Readable error text for logs and stored failure reasons. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
