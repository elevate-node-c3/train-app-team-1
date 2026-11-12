/** Language-free validation details carried internally and across gRPC. */
export interface ValidationIssueRef {
  field: string;
  rejectedValue: unknown;
  issueKey: string;
  actionKey?: string;
  params?: Record<string, string>;
}
