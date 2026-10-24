/** The readable half of an unknown throwable, for logs and stored reasons. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
