export type SyncConflictDescriptor = {
  status: string;
  entityType: string;
  code?: string;
};

export type MissingParentCandidate = {
  mutationId: string;
  firstSeenAt: string;
};

export const MISSING_PARENT_CONFIRMATION_DELAY_MS = 30_000;

export function isMissingParentReportConflict({
  status,
  entityType,
  code,
}: SyncConflictDescriptor): boolean {
  return status === 'conflict' && entityType === 'report' && code === 'missing_parent';
}

export function shouldConfirmMissingParentReport(
  candidate: MissingParentCandidate | null,
  mutationId: string,
  nowMs: number,
): boolean {
  if (!candidate || candidate.mutationId !== mutationId) return false;
  const firstSeenMs = Date.parse(candidate.firstSeenAt);
  return Number.isFinite(firstSeenMs)
    && nowMs - firstSeenMs >= MISSING_PARENT_CONFIRMATION_DELAY_MS;
}
