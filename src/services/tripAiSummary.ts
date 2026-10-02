import { Capacitor } from '@capacitor/core';
import { buildImportableDayRunsFromAppEvents } from '../domain/reportLogic';
import type { AppEvent } from '../domain/types';
import type { TripViewModel } from '../state/selectors';
import { copyNativeText } from './nativeShare';

export type AiSharePayload = {
  recordType: 'operation_log';
  tripId: string;
  generatedAt: string;
  dayRuns: ReturnType<typeof buildImportableDayRunsFromAppEvents>;
  summary: {
    hasTripEnd: boolean;
    startTs: string;
    endTs: string | null;
    startAddress?: string;
    endAddress?: string;
    odoStart: number;
    odoEnd: number | null;
    totalKm: number | null;
    lastLegKm: number | null;
  };
  segments: Array<{
    index: number;
    toTs?: string;
    toOdo: number;
    restSessionIdTo?: string;
  }>;
  timeline: TripViewModel['timeline'];
};

export function buildTripAiSummaryPayload(
  tripId: string,
  vm: TripViewModel,
  events: AppEvent[],
  generatedAt = new Date().toISOString(),
): AiSharePayload {
  if (vm.tripId !== tripId) throw new Error('運行データの対象が一致しません');
  const tripEvents = events.filter(event => event.tripId === tripId);
  const sorted = [...tripEvents].sort((a, b) => a.ts.localeCompare(b.ts));
  const tripStart = sorted.find(event => event.type === 'trip_start');
  if (!tripStart) {
    throw new Error('運行開始イベントが見つからないため共有できません');
  }
  const tripEnd = [...sorted].reverse().find(event => event.type === 'trip_end');
  const dayRuns = buildImportableDayRunsFromAppEvents(tripEvents, vm.dayRuns, { currentTs: generatedAt });
  return {
    recordType: 'operation_log',
    tripId,
    generatedAt,
    dayRuns,
    summary: {
      hasTripEnd: vm.hasTripEnd,
      startTs: tripStart.ts,
      endTs: tripEnd?.ts ?? null,
      ...(tripStart.address ? { startAddress: tripStart.address } : {}),
      ...(tripEnd?.address ? { endAddress: tripEnd.address } : {}),
      odoStart: vm.odoStart,
      odoEnd: vm.odoEnd ?? null,
      totalKm: vm.totalKm ?? null,
      lastLegKm: vm.lastLegKm ?? null,
    },
    segments: vm.segments.map(segment => ({
      index: segment.index,
      ...(segment.toTs ? { toTs: segment.toTs } : {}),
      toOdo: segment.toOdo,
      ...(segment.restSessionIdTo ? { restSessionIdTo: segment.restSessionIdTo } : {}),
    })),
    timeline: vm.timeline,
  };
}

export async function copyTripAiSummaryText(text: string): Promise<number> {
  if (Capacitor.isNativePlatform()) {
    try {
      const copiedLength = await copyNativeText({ label: 'TrackLog AI要約用データ', text });
      if (copiedLength === text.length) return copiedLength;
    } catch {
      // Older native builds may not expose native clipboard support yet.
    }
  }
  if (navigator.clipboard?.writeText) {
    let timeout: number | undefined;
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('クリップボード応答待ちがタイムアウトしました')), 1_500);
        }),
      ]);
      return text.length;
    } catch {
      // Android WebView can deny clipboard writes even when the API exists.
      // Fall back to a hidden textarea copy before surfacing an error.
    } finally {
      if (timeout != null) window.clearTimeout(timeout);
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    if (!document.execCommand('copy')) throw new Error('コピーに失敗しました');
  } finally {
    area.remove();
  }
  return text.length;
}
