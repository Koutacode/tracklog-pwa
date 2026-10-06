export type ExpresswayIcDisplayState = 'resolved' | 'manual' | 'estimated' | 'pending' | 'failed' | 'unresolved';

export type ExpresswayIcDisplay = {
  label: string;
  name?: string;
  detail: string;
  state: ExpresswayIcDisplayState;
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function estimateNames(value: unknown): string[] {
  if (typeof value === 'string') return text(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(estimateNames);
  if (!value || typeof value !== 'object') return [];
  const estimate = value as Record<string, unknown>;
  const name = text(estimate.displayName) ?? text(estimate.icName) ?? text(estimate.name);
  return name ? [name] : [...estimateNames(estimate.candidateNames), ...estimateNames(estimate.candidates)];
}

/** Presentation only: never promotes address estimates or alters event data. */
export function getExpresswayIcDisplay(extras: Record<string, unknown> = {}): ExpresswayIcDisplay {
  const name = text(extras.icName);
  const manual = extras.icResolvedManually === true && !!name;
  const estimate = extras.icNameEstimate;
  const savedEstimateName = estimate && typeof estimate === 'object'
    ? text((estimate as Record<string, unknown>).displayName) : undefined;
  // Historic estimate evidence may remain after a later resolution. Its
  // displayName identifies the value it describes; it is not a permanent flag.
  const activeEstimate = estimate != null && estimate !== false
    && (!savedEstimateName || !name || savedEstimateName === name);
  const estimated = !manual && (activeEstimate
    || !!name?.match(/[（(]推定(?:候補)?[）)]/));
  const candidates = [...new Set(estimateNames(estimate))];
  let displayName = name ?? (candidates.length ? candidates.join(' / ') : undefined);
  const candidateNames = activeEstimate && estimate && typeof estimate === 'object'
    ? [...new Set(estimateNames((estimate as Record<string, unknown>).candidateNames))] : [];
  if (candidateNames.length > 1 && !candidateNames.every(candidate => displayName?.includes(candidate))) {
    // A nearby lookup can store a representative name and several alternatives.
    // Showing only that representative would imply it was the chosen entrance.
    displayName = candidateNames.join(' / ');
  }
  const status = text(extras.icResolveStatus);
  const error = text(extras.icResolveError);
  const retry = !!text(extras.icResolveNextRetryAt);

  if (manual) {
    return { name, label: `${name}（手動修正）`, detail: '手動修正済み', state: 'manual' };
  }
  if (!estimated && name && (status == null || status === 'resolved')) {
    const distance = extras.icDistanceM;
    const suffix = typeof distance === 'number' && Number.isFinite(distance) && distance >= 0
      ? ` / 約${Math.round(distance)}m` : '';
    return { name, label: name, detail: `取得済み${suffix}`, state: 'resolved' };
  }

  const failed = status === 'failed' || !!error;
  const statusLabel = failed
    ? `取得失敗${retry || status === 'pending' ? '・再取得待ち' : ''}`
    : status === 'pending' ? (retry ? '再取得待ち' : '取得中・取得待ち') : '未確定';
  const guidance = failed
    ? retry || status === 'pending'
      ? 'IC名を取得できませんでした。通信できるときに再取得します'
      : 'IC名を取得できませんでした。詳細・修正画面で確認できます'
    : status === 'pending'
      ? 'オンライン時に保存済みの位置情報から取得します'
      : '詳細・修正画面でIC名を確認できます';
  if (estimated) {
    const candidateLabel = displayName
      ? /[（(]推定(?:候補)?[）)]/.test(displayName) ? displayName : `${displayName}（推定候補）`
      : '推定候補あり';
    return {
      name: displayName,
      label: `${candidateLabel} / ${statusLabel}`,
      detail: `推定候補のため未確定です。${guidance}`,
      state: 'estimated',
    };
  }
  return {
    name,
    label: `${name ? `${name}（未確定）` : 'IC名未取得'}（${statusLabel}）`,
    detail: guidance,
    state: failed ? 'failed' : status === 'pending' ? 'pending' : 'unresolved',
  };
}
