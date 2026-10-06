/** Address-derived candidates remain estimates until independently confirmed. */
export type IcNameEstimate = {
  note: string;
  source: 'saved_address_official_sources' | string;
  certainty: 'estimated' | 'ambiguous_candidates';
  sourceUrls: string[];
  displayName: string;
  estimatedAt: string;
  candidateNames: string[];
};

export const IC_METADATA_FIELDS = [
  'icName', 'icNameEstimate', 'icNameEstimateHistory', 'icDistanceM', 'icResolveStatus', 'icResolveAlgorithmVersion',
  'icResolvedManually', 'icResolveManualUpdatedAt', 'icResolveManualClearedAt',
  'icResolveGeoSource', 'icResolveGeoOffsetSeconds', 'icResolveRetryCount',
  'icResolveNextRetryAt', 'icResolveLastAttemptAt', 'icResolveError',
  'icNameSearchSourceId', 'icNameSearchAddressUpdated',
] as const;

export function icMetadataText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(icMetadataText(value) ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isEstimatedIcName(extras: Record<string, unknown> | undefined): boolean {
  if (extras?.icResolvedManually === true) return false;
  const name = icMetadataText(extras?.icName);
  if (name && /[（(]推定(?:候補)?[）)]/.test(name)) return true;
  const estimate = extras?.icNameEstimate;
  return !!estimate && typeof estimate === 'object' && !Array.isArray(estimate)
    && !!icMetadataText((estimate as Record<string, unknown>).displayName)
    && (!name || icMetadataText((estimate as Record<string, unknown>).displayName) === name);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function sameIcMetadata(left?: Record<string, unknown>, right?: Record<string, unknown>): boolean {
  return IC_METADATA_FIELDS.every(key => sameValue(left?.[key], right?.[key]));
}

/**
 * Merge IC metadata only. Operational fields always come from the incoming row.
 * Incomplete downloads and retry results cannot erase evidence or a manual edit.
 */
export function mergeIcMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
  options: { incomingIsNewer?: boolean } = {},
): Record<string, unknown> | undefined {
  if (!existing) return incoming;
  const result = { ...incoming };
  const oldName = icMetadataText(existing.icName);
  const nextName = icMetadataText(incoming?.icName);
  const oldManual = existing.icResolvedManually === true && !!oldName;
  const nextManual = incoming?.icResolvedManually === true && !!nextName;
  const clearedAt = timestamp(incoming?.icResolveManualClearedAt);
  const oldManualAt = timestamp(existing.icResolveManualUpdatedAt);
  const nextManualAt = timestamp(incoming?.icResolveManualUpdatedAt);
  const explicitManualClear = clearedAt > 0 && clearedAt >= oldManualAt;
  const oldConfirmed = !!oldName && !isEstimatedIcName(existing)
    && (oldManual || existing.icResolveStatus == null || existing.icResolveStatus === 'resolved');
  const nextConfirmed = !!nextName && !isEstimatedIcName(incoming)
    && (nextManual || incoming?.icResolveStatus == null || incoming.icResolveStatus === 'resolved');
  let keepOldResolution = false;
  if (oldManual) {
    keepOldResolution = nextManual
      ? nextManualAt < oldManualAt || (nextManualAt === oldManualAt
        && nextName !== oldName && options.incomingIsNewer !== true)
      : !explicitManualClear;
  } else if (nextManual && timestamp(existing.icResolveManualClearedAt) > 0
    && timestamp(existing.icResolveManualClearedAt) >= nextManualAt) {
    keepOldResolution = true; // An old device must not resurrect an explicitly replaced manual value.
  } else if (oldConfirmed) {
    keepOldResolution = !nextConfirmed || (!nextManual
      && (Number(incoming?.icResolveAlgorithmVersion ?? 0) < Number(existing.icResolveAlgorithmVersion ?? 0)
        || (timestamp(existing.icResolveLastAttemptAt) > 0 && timestamp(incoming?.icResolveLastAttemptAt) > 0
          && timestamp(existing.icResolveLastAttemptAt) > timestamp(incoming?.icResolveLastAttemptAt))));
  } else if (isEstimatedIcName(existing) && isEstimatedIcName(incoming)) {
    keepOldResolution = timestamp((existing.icNameEstimate as IcNameEstimate | undefined)?.estimatedAt)
      > timestamp((incoming?.icNameEstimate as IcNameEstimate | undefined)?.estimatedAt);
  }
  if (keepOldResolution) {
    for (const key of IC_METADATA_FIELDS) {
      delete result[key];
      if (Object.prototype.hasOwnProperty.call(existing, key)) result[key] = existing[key];
    }
  } else if (oldName && !nextName) {
    // A failure may update progress, but a previously saved estimate stays visible.
    for (const key of ['icName', 'icDistanceM', 'icResolveGeoSource', 'icResolveGeoOffsetSeconds'] as const) {
      if (Object.prototype.hasOwnProperty.call(existing, key)) result[key] = existing[key];
    }
  }
  if (!result.icNameEstimate && existing.icNameEstimate) result.icNameEstimate = existing.icNameEstimate;
  if (!keepOldResolution && ['pending', 'failed'].includes(String(incoming?.icResolveStatus))
    && timestamp(existing.icResolveLastAttemptAt) > timestamp(incoming?.icResolveLastAttemptAt)) {
    for (const key of ['icResolveStatus', 'icResolveAlgorithmVersion', 'icResolveRetryCount',
      'icResolveNextRetryAt', 'icResolveLastAttemptAt', 'icResolveError'] as const) {
      delete result[key];
      if (Object.prototype.hasOwnProperty.call(existing, key)) result[key] = existing[key];
    }
  }
  const history = [
    ...(Array.isArray(existing.icNameEstimateHistory) ? existing.icNameEstimateHistory : []),
    ...(Array.isArray(incoming?.icNameEstimateHistory) ? incoming.icNameEstimateHistory : []),
    ...(existing.icNameEstimate && !sameValue(result.icNameEstimate, existing.icNameEstimate) ? [existing.icNameEstimate] : []),
  ].filter((item, index, all) => !!item && typeof item === 'object'
    && all.findIndex(other => sameValue(other, item)) === index);
  if (history.length) result.icNameEstimateHistory = history.length > 8 ? [history[0], ...history.slice(-7)] : history;
  // Keep the clearing marker across older clients so manual history cannot return.
  if (timestamp(existing.icResolveManualClearedAt) > timestamp(result.icResolveManualClearedAt)) {
    result.icResolveManualClearedAt = existing.icResolveManualClearedAt;
  }
  return Object.keys(result).length ? result : incoming;
}
