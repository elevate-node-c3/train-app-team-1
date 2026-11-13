/** Language-free validation details carried internally and across gRPC. */
export interface ValidationIssueRef {
  field: string;
  rejectedValue: unknown;
  issueKey: string;
  actionKey?: string;
  params?: Record<string, string>;
}

/** Guards a ref restored from a transport, where nothing is type-checked yet. */
export function isValidationIssueRef(
  value: unknown,
): value is ValidationIssueRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.field === 'string' &&
    typeof candidate.issueKey === 'string' &&
    (candidate.actionKey === undefined ||
      typeof candidate.actionKey === 'string') &&
    (candidate.params === undefined ||
      (typeof candidate.params === 'object' &&
        candidate.params !== null &&
        !Array.isArray(candidate.params) &&
        Object.values(candidate.params).every(
          (param) => typeof param === 'string',
        )))
  );
}
