import type { Geo } from '../domain/types';
import { reverseGeocode } from './geo';
import { invokeIcResolverAction } from './icResolver';

export type ExpresswayIcNameCandidate = {
  id: string;
  icName: string;
  geo: Geo;
  address?: string;
};

export type ExpresswayIcManualSelection = {
  id: string;
  icName: string;
  address?: string;
};

export function parseExpresswayIcNameCandidates(value: unknown): ExpresswayIcNameCandidate[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).candidates)) {
    throw new Error('IC名検索の応答を確認できませんでした');
  }
  const result: ExpresswayIcNameCandidate[] = [];
  for (const row of (value as { candidates: unknown[] }).candidates.slice(0, 12)) {
    if (!row || typeof row !== 'object') continue;
    const candidate = row as Record<string, unknown>;
    const icName = typeof candidate.icName === 'string' ? candidate.icName.trim() : '';
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const lat = candidate.lat;
    const lng = candidate.lon;
    if (!/^(node|way|relation)\/\d+$/.test(id) || !icName || icName.length > 80 ||
      typeof lat !== 'number' || !Number.isFinite(lat) || lat < 20 || lat > 46 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < 122 || lng > 154) continue;
    const address = typeof candidate.address === 'string' ? candidate.address.trim().slice(0, 300) : '';
    result.push({ id, icName, geo: { lat, lng }, ...(address ? { address } : {}) });
  }
  return result;
}

export async function searchExpresswayIcNames(query: string): Promise<ExpresswayIcNameCandidate[]> {
  const text = query.trim();
  if (text.length < 2 || text.length > 80) throw new Error('IC名を2〜80文字で入力してください');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('候補の検索にはインターネット接続が必要です。名前だけの保存はできます');
  }
  const result = await invokeIcResolverAction<unknown>({ action: 'search-name', query: text });
  return parseExpresswayIcNameCandidates(result);
}

/** Resolves the selected public map feature, never the driver's current position. */
export async function prepareExpresswayIcManualSelection(
  candidate: ExpresswayIcNameCandidate,
  lookupAddress: (geo: Geo) => Promise<string | undefined> = reverseGeocode,
): Promise<ExpresswayIcManualSelection> {
  const address = candidate.address || await lookupAddress(candidate.geo);
  return { id: candidate.id, icName: candidate.icName, ...(address?.trim() ? { address: address.trim() } : {}) };
}

export function validateExpresswayIcManualSelection(name: string, selection: ExpresswayIcManualSelection) {
  if (!/^(node|way|relation)\/\d+$/.test(selection.id) || selection.icName !== name) {
    throw new Error('候補を選び直してください');
  }
  if (selection.address != null && (!selection.address.trim() || selection.address.length > 300)) {
    throw new Error('候補の住所を確認できませんでした');
  }
}
