import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getEventsByTripId, listRoutePointsByTripId } from '../../db/repositories';
import type { AppEvent, RoutePoint } from '../../domain/types';
import { getJstDateInfo } from '../../domain/jst';
import { mapMatchRoutePoints, type LatLng, type MatchProvider } from '../../services/mapMatching';

const COLOR_PALETTE = ['#0ea5e9', '#22c55e', '#f97316', '#e11d48', '#a855f7', '#14b8a6', '#f59e0b', '#10b981'];
const MAX_SEGMENT_GAP_MS = 4 * 60 * 1000;
const MAX_SEGMENT_DISTANCE_M = 1500;
const MAX_SEGMENT_SPEED_KMH = 135;
const MAX_RENDER_POINTS_PER_SEGMENT = 900;
const MAX_MATCH_POINTS_PER_SEGMENT = 240;

type RouteSegment = {
  segmentKey: string;
  dateKey: string;
  dateLabel: string;
  dayStamp: number;
  partIndex: number;
  sourceKind: 'recorded' | 'eventFallback';
  color: string;
  path: LatLng[];
  distanceKm: number;
  pointCount: number;
  startTs?: string;
  endTs?: string;
  points: RoutePoint[];
  gapFromPrevMs: number;
  gapFromPrevMeters: number;
};

type RouteDaySummary = {
  dateKey: string;
  dateLabel: string;
  color: string;
  pointCount: number;
  recordedPointCount: number;
  fallbackPointCount: number;
  gapCount: number;
  displayDistanceKm: number;
  providers: MatchProvider[];
  rawSegmentCount: number;
  routeFallbackCount: number;
  routeMatchedCount: number;
  quality: 'good' | 'watch' | 'poor';
  qualityLabel: string;
  qualityReason: string;
};

function summarizeRouteQuality(day: Omit<RouteDaySummary, 'quality' | 'qualityLabel' | 'qualityReason'>) {
  if (day.recordedPointCount === 0 && day.fallbackPointCount > 0) {
    return {
      quality: 'poor' as const,
      qualityLabel: '要確認',
      qualityReason: 'GPS記録がなく、イベント補助地点のみです',
    };
  }
  if (day.gapCount >= 3) {
    return {
      quality: 'poor' as const,
      qualityLabel: '要確認',
      qualityReason: `欠損分割が ${day.gapCount} 件あります`,
    };
  }
  if (day.fallbackPointCount > 0 || day.routeFallbackCount > 0 || day.rawSegmentCount > 0 || day.gapCount > 0) {
    return {
      quality: 'watch' as const,
      qualityLabel: '注意',
      qualityReason: '補助ルートまたは欠損区間があります',
    };
  }
  return {
    quality: 'good' as const,
    qualityLabel: '良好',
    qualityReason: 'GPS実記録を中心にルートを描画できています',
  };
}

function qualityBadgeStyle(quality: RouteDaySummary['quality']) {
  if (quality === 'good') {
    return {
      border: '1px solid rgba(34, 197, 94, 0.3)',
      background: 'rgba(21, 128, 61, 0.18)',
      color: '#bbf7d0',
    };
  }
  if (quality === 'watch') {
    return {
      border: '1px solid rgba(245, 158, 11, 0.3)',
      background: 'rgba(180, 83, 9, 0.18)',
      color: '#fde68a',
    };
  }
  return {
    border: '1px solid rgba(248, 113, 113, 0.3)',
    background: 'rgba(127, 29, 29, 0.18)',
    color: '#fecaca',
  };
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function buildSegments(points: RoutePoint[]): RouteSegment[] {
  const groups = new Map<
    string,
    { dateLabel: string; dayStamp: number; points: RoutePoint[] }
  >();
  for (const pt of points) {
    const info = getJstDateInfo(pt.ts);
    const entry = groups.get(info.dateKey);
    if (entry) {
      entry.points.push(pt);
    } else {
      groups.set(info.dateKey, { dateLabel: info.dateLabel, dayStamp: info.dayStamp, points: [pt] });
    }
  }
  return [...groups.entries()]
    .flatMap(([dateKey, info], idx) => {
      const pts = [...info.points].sort((a, b) => a.ts.localeCompare(b.ts));
      if (pts.length === 0) return [];

      const parts: Array<{ points: RoutePoint[]; gapFromPrevMs: number; gapFromPrevMeters: number }> = [];
      let current = [pts[0]];
      let pendingGapFromPrevMs = 0;
      let pendingGapFromPrevMeters = 0;

      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const next = pts[i];
        const gapMs = Math.max(0, new Date(next.ts).getTime() - new Date(prev.ts).getTime());
        const gapMeters = distanceMeters(prev, next);
        const speedKmh = gapMs > 0 ? gapMeters / (gapMs / 3600000) : 0;
        const shouldSplit =
          gapMs > MAX_SEGMENT_GAP_MS ||
          gapMeters > MAX_SEGMENT_DISTANCE_M ||
          speedKmh > MAX_SEGMENT_SPEED_KMH;

        if (shouldSplit) {
          parts.push({
            points: current,
            gapFromPrevMs: pendingGapFromPrevMs,
            gapFromPrevMeters: pendingGapFromPrevMeters,
          });
          current = [next];
          pendingGapFromPrevMs = gapMs;
          pendingGapFromPrevMeters = gapMeters;
          continue;
        }

        current.push(next);
      }

      parts.push({
        points: current,
        gapFromPrevMs: pendingGapFromPrevMs,
        gapFromPrevMeters: pendingGapFromPrevMeters,
      });

      return parts.map((part, partIndex) => {
        let dist = 0;
        for (let i = 1; i < part.points.length; i++) {
          dist += distanceMeters(part.points[i - 1], part.points[i]);
        }
        return {
          segmentKey: `${dateKey}-${partIndex}`,
          dateKey,
          dateLabel: info.dateLabel,
          dayStamp: info.dayStamp,
          partIndex,
          sourceKind: 'recorded' as const,
          color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
          path: part.points.map(pt => ({ lat: pt.lat, lng: pt.lng })),
          distanceKm: Math.round((dist / 1000) * 10) / 10,
          pointCount: part.points.length,
          startTs: part.points[0]?.ts,
          endTs: part.points[part.points.length - 1]?.ts,
          points: part.points,
          gapFromPrevMs: part.gapFromPrevMs,
          gapFromPrevMeters: Math.round(part.gapFromPrevMeters),
        };
      });
    })
    .sort((a, b) => a.dayStamp - b.dayStamp);
}

function buildEventFallbackSegments(events: AppEvent[]): RouteSegment[] {
  const grouped = new Map<string, { dateLabel: string; dayStamp: number; points: RoutePoint[] }>();
  for (const event of events) {
    if (!event.geo) continue;
    const info = getJstDateInfo(event.ts);
    const point: RoutePoint = {
      id: `event-${event.id}`,
      tripId: event.tripId,
      ts: event.ts,
      lat: event.geo.lat,
      lng: event.geo.lng,
      ...(Number.isFinite(event.geo.accuracy) ? { accuracy: event.geo.accuracy } : {}),
      source: 'event',
    };
    const entry = grouped.get(info.dateKey);
    if (entry) {
      entry.points.push(point);
    } else {
      grouped.set(info.dateKey, {
        dateLabel: info.dateLabel,
        dayStamp: info.dayStamp,
        points: [point],
      });
    }
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dateKey, info], idx) => {
      const points = [...info.points].sort((a, b) => a.ts.localeCompare(b.ts));
      let dist = 0;
      for (let i = 1; i < points.length; i++) {
        dist += distanceMeters(points[i - 1], points[i]);
      }
      return {
        segmentKey: `fallback-${dateKey}`,
        dateKey,
        dateLabel: info.dateLabel,
        dayStamp: info.dayStamp,
        partIndex: 0,
        sourceKind: 'eventFallback',
        color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
        path: points.map(point => ({ lat: point.lat, lng: point.lng })),
        distanceKm: Math.round((dist / 1000) * 10) / 10,
        pointCount: points.length,
        startTs: points[0]?.ts,
        endTs: points[points.length - 1]?.ts,
        points,
        gapFromPrevMs: 0,
        gapFromPrevMeters: 0,
      } satisfies RouteSegment;
    });
}

function distanceKm(path: LatLng[]) {
  let distM = 0;
  for (let i = 1; i < path.length; i++) {
    distM += distanceMeters(path[i - 1], path[i]);
  }
  return Math.round((distM / 1000) * 10) / 10;
}

function thinByIndex<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems || maxItems < 2) return items;
  const result: T[] = [items[0]];
  const lastIndex = items.length - 1;
  for (let i = 1; i < maxItems - 1; i++) {
    const index = Math.round((i * lastIndex) / (maxItems - 1));
    const item = items[index];
    if (item !== result[result.length - 1]) {
      result.push(item);
    }
  }
  const last = items[lastIndex];
  if (last !== result[result.length - 1]) {
    result.push(last);
  }
  return result;
}

function fmtDateTime(ts?: string) {
  if (!ts) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function shouldUseRouteCorrection(segment: RouteSegment) {
  return segment.sourceKind === 'eventFallback';
}

export default function RouteMapScreen() {
  const { tripId } = useParams();
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenDates, setHiddenDates] = useState<Set<string>>(new Set());
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [useMapMatching, setUseMapMatching] = useState(true);
  const [matchingStatus, setMatchingStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'offline'>('idle');
  const [matchedBySegment, setMatchedBySegment] = useState<Record<string, { path: LatLng[]; provider: MatchProvider }>>({});
  const matchingRunRef = useRef(0);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const fitBoundsRef = useRef<(() => void) | null>(null);

  const trackedPoints = useMemo(() => points.filter(point => point.source !== 'event'), [points]);
  const recordedSegments = useMemo(() => buildSegments(trackedPoints), [trackedPoints]);
  const fallbackSegments = useMemo(() => buildEventFallbackSegments(events), [events]);
  const segments = useMemo(() => {
    const daysWithRecordedPolyline = new Set(
      recordedSegments.filter(segment => segment.path.length >= 2).map(segment => segment.dateKey),
    );
    return [...recordedSegments, ...fallbackSegments.filter(segment => !daysWithRecordedPolyline.has(segment.dateKey))]
      .sort((a, b) => a.dayStamp - b.dayStamp || a.partIndex - b.partIndex);
  }, [fallbackSegments, recordedSegments]);
  const displaySegments = useMemo(() => {
    return segments.map(seg => {
      if (!useMapMatching) {
        return {
          ...seg,
          displayPath: seg.path,
          renderPath: thinByIndex(seg.path, MAX_RENDER_POINTS_PER_SEGMENT),
          displayDistanceKm: seg.distanceKm,
          matchProvider: 'raw' as const,
        };
      }
      const matched = matchedBySegment[seg.segmentKey];
      const path = matched?.path && matched.path.length >= 2 ? matched.path : seg.path;
      return {
        ...seg,
        displayPath: path,
        renderPath: thinByIndex(path, MAX_RENDER_POINTS_PER_SEGMENT),
        displayDistanceKm: distanceKm(path),
        matchProvider: matched?.provider ?? 'raw',
      };
    });
  }, [segments, matchedBySegment, useMapMatching]);
  const visibleSegments = useMemo(
    () => displaySegments.filter(seg => !hiddenDates.has(seg.dateKey)),
    [displaySegments, hiddenDates],
  );
  const correctableVisibleSegments = useMemo(
    () => visibleSegments.filter(seg => shouldUseRouteCorrection(seg) && seg.points.length >= 2),
    [visibleSegments],
  );
  const visiblePoints = useMemo(() => {
    const items = visibleSegments.flatMap(segment => segment.points);
    const deduped = new Map<string, RoutePoint>();
    for (const point of items) {
      const key = `${point.id}-${point.ts}`;
      deduped.set(key, point);
    }
    return [...deduped.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }, [visibleSegments]);
  const totalDistanceKm = useMemo(() => {
    return displaySegments.reduce((sum, seg) => sum + seg.displayDistanceKm, 0);
  }, [displaySegments]);
  const daySummaries = useMemo<RouteDaySummary[]>(() => {
    const byDay = new Map<string, RouteDaySummary>();
    for (const seg of displaySegments) {
      const entry = byDay.get(seg.dateKey);
      if (entry) {
        entry.pointCount += seg.pointCount;
        if (seg.sourceKind === 'recorded') {
          entry.recordedPointCount += seg.pointCount;
        } else {
          entry.fallbackPointCount += seg.pointCount;
        }
        entry.displayDistanceKm += seg.displayDistanceKm;
        if (seg.partIndex > 0) entry.gapCount += 1;
        if (!entry.providers.includes(seg.matchProvider)) {
          entry.providers.push(seg.matchProvider);
        }
        if (seg.matchProvider === 'raw') entry.rawSegmentCount += 1;
        if (seg.matchProvider === 'osrm-route') entry.routeFallbackCount += 1;
        if (seg.matchProvider === 'osrm-match') entry.routeMatchedCount += 1;
      } else {
        byDay.set(seg.dateKey, {
          dateKey: seg.dateKey,
          dateLabel: seg.dateLabel,
          color: seg.color,
          pointCount: seg.pointCount,
          recordedPointCount: seg.sourceKind === 'recorded' ? seg.pointCount : 0,
          fallbackPointCount: seg.sourceKind === 'eventFallback' ? seg.pointCount : 0,
          gapCount: seg.partIndex > 0 ? 1 : 0,
          displayDistanceKm: seg.displayDistanceKm,
          providers: [seg.matchProvider],
          rawSegmentCount: seg.matchProvider === 'raw' ? 1 : 0,
          routeFallbackCount: seg.matchProvider === 'osrm-route' ? 1 : 0,
          routeMatchedCount: seg.matchProvider === 'osrm-match' ? 1 : 0,
          quality: 'watch',
          qualityLabel: '',
          qualityReason: '',
        });
      }
    }
    return [...byDay.values()]
      .map(day => ({
        ...day,
        ...summarizeRouteQuality(day),
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }, [displaySegments]);
  const qualityCounts = useMemo(
    () => ({
      good: daySummaries.filter(day => day.quality === 'good').length,
      watch: daySummaries.filter(day => day.quality === 'watch').length,
      poor: daySummaries.filter(day => day.quality === 'poor').length,
    }),
    [daySummaries],
  );
  const rawSegmentCount = useMemo(
    () => displaySegments.filter(seg => seg.matchProvider === 'raw').length,
    [displaySegments],
  );
  const routeFallbackCount = useMemo(
    () => displaySegments.filter(seg => seg.matchProvider === 'osrm-route').length,
    [displaySegments],
  );
  const routeMatchedCount = useMemo(
    () => displaySegments.filter(seg => seg.matchProvider === 'osrm-match').length,
    [displaySegments],
  );
  const brokenSegmentCount = useMemo(
    () => segments.filter(seg => seg.partIndex > 0).length,
    [segments],
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
    };
  }, []);

  useEffect(() => {
    if (!tripId) {
      setError('tripId が不正です');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [routePointRows, eventRows] = await Promise.all([
          listRoutePointsByTripId(tripId),
          getEventsByTripId(tripId),
        ]);
        if (cancelled) return;
        setPoints(routePointRows);
        setEvents(eventRows);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? 'ルート取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (mapInstanceRef.current) return;

    const map = L.map(mapRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([35.681236, 139.767125], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    mapInstanceRef.current = map;
    layerGroupRef.current = L.layerGroup().addTo(map);

    return () => {
      fitBoundsRef.current = null;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
      layerGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    matchingRunRef.current += 1;
    setMatchedBySegment(prev => {
      const validKeys = new Set(segments.map(seg => seg.segmentKey));
      const next = Object.fromEntries(Object.entries(prev).filter(([key]) => validKeys.has(key)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
    setMatchingStatus('idle');
  }, [segments]);

  const runCorrectionForVisibleSegments = async () => {
    if (!isOnline) {
      setMatchingStatus('offline');
      return;
    }
    const segmentsToCorrect = correctableVisibleSegments.filter(seg => !matchedBySegment[seg.segmentKey]);
    if (segmentsToCorrect.length === 0) {
      setMatchingStatus(correctableVisibleSegments.length > 0 ? 'done' : 'idle');
      return;
    }
    const runId = matchingRunRef.current + 1;
    matchingRunRef.current = runId;
    setUseMapMatching(true);
    setMatchingStatus('running');
    try {
      for (const seg of segmentsToCorrect) {
        const pointsForMatching = thinByIndex(seg.points, MAX_MATCH_POINTS_PER_SEGMENT);
        const matched = await mapMatchRoutePoints(pointsForMatching, {
          preferRoute: seg.sourceKind === 'eventFallback',
        });
        if (matchingRunRef.current !== runId) return;
        setMatchedBySegment(prev => ({
          ...prev,
          [seg.segmentKey]: matched,
        }));
      }
      if (matchingRunRef.current === runId) {
        setMatchingStatus('done');
      }
    } catch {
      if (matchingRunRef.current === runId) {
        setMatchingStatus('error');
      }
    }
  };

  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();
    const bounds = L.latLngBounds([]);

    for (const seg of visibleSegments) {
      if (seg.renderPath.length < 2) continue;
      const path = seg.renderPath.map(pt => L.latLng(pt.lat, pt.lng));
      L.polyline(path, {
        color: seg.color,
        weight: 4,
        opacity: 0.9,
      }).addTo(layerGroup);
      for (const p of path) bounds.extend(p);
    }

    if (visiblePoints.length > 0) {
      const start = visiblePoints[0];
      const end = visiblePoints[visiblePoints.length - 1];
      const startPoint = L.latLng(start.lat, start.lng);
      const endPoint = L.latLng(end.lat, end.lng);
      L.circleMarker(startPoint, {
        radius: 7,
        color: '#16a34a',
        weight: 2,
        fillColor: '#16a34a',
        fillOpacity: 0.9,
      })
        .addTo(layerGroup)
        .bindTooltip('S', { permanent: true, direction: 'top' });
      L.circleMarker(endPoint, {
        radius: 7,
        color: '#dc2626',
        weight: 2,
        fillColor: '#dc2626',
        fillOpacity: 0.9,
      })
        .addTo(layerGroup)
        .bindTooltip('E', { permanent: true, direction: 'top' });
      bounds.extend(startPoint);
      bounds.extend(endPoint);
    }

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
      fitBoundsRef.current = () => map.fitBounds(bounds, { padding: [40, 40] });
    } else {
      fitBoundsRef.current = null;
    }
  }, [visibleSegments, visiblePoints]);

  return (
    <div className="page-shell">
      <div className="trip-detail__header">
        <div>
          <div className="trip-detail__title">ルート表示</div>
          <div className="trip-detail__meta">運行ID: {tripId}</div>
        </div>
        <div className="trip-detail__actions">
          <Link to="/" className="trip-detail__button">ホーム</Link>
          {tripId && <Link to={`/trip/${tripId}`} className="trip-detail__button">運行詳細</Link>}
          <Link to="/history" className="trip-detail__button">運行履歴</Link>
        </div>
      </div>

      {error && <div className="trip-detail__alert">{error}</div>}
      {loading && !error && <div>読み込み中…</div>}

      <div className="card" style={{ padding: 12, color: '#fff', marginBottom: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>ルート概要</div>
        <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          <div>記録点: {trackedPoints.length} 件 / 補助地点: {fallbackSegments.reduce((sum, segment) => sum + segment.pointCount, 0)} 件 / 日数: {daySummaries.length} 日</div>
          <div>推定距離: {totalDistanceKm.toFixed(1)} km {useMapMatching && (routeMatchedCount > 0 || routeFallbackCount > 0) ? '(補正反映あり)' : '(生データ)'}</div>
          <div>開始: {fmtDateTime(visiblePoints[0]?.ts ?? trackedPoints[0]?.ts)} / 終了: {fmtDateTime(visiblePoints[visiblePoints.length - 1]?.ts ?? trackedPoints[trackedPoints.length - 1]?.ts)}</div>
          <div>欠損区間で分割: {brokenSegmentCount} 区間</div>
          {useMapMatching && (
            <div style={{ opacity: 0.85 }}>
              補正状態:
              {matchingStatus === 'running' && ' 補正中…'}
              {matchingStatus === 'done' && ' 補正完了'}
              {matchingStatus === 'offline' && ' オフライン（補正停止）'}
              {matchingStatus === 'error' && ' 補正失敗（生データ表示）'}
              {matchingStatus === 'idle' && ' 待機中'}
            </div>
          )}
          <div style={{ opacity: 0.75 }}>
            地図描画: 表示用に最大 {MAX_RENDER_POINTS_PER_SEGMENT} 点/区間へ軽量化（始点・終点は保持）
          </div>
          {useMapMatching && (
            <div style={{ opacity: 0.75 }}>
              補正内訳: OSRMマッチ {routeMatchedCount} 区間 / OSRM経路補完 {routeFallbackCount} 区間 / 生データ {rawSegmentCount} 区間
            </div>
          )}
          <div style={{ opacity: 0.75 }}>
            品質目安: 良好 {qualityCounts.good} 日 / 注意 {qualityCounts.watch} 日 / 要確認 {qualityCounts.poor} 日
          </div>
          <div style={{ opacity: 0.75 }}>
            GPS 記録が弱い日はイベント地点から道路沿いの補助ルートを描画し、長い欠損は誤って一直線で結ばないよう分割表示します。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button
            className="trip-detail__button trip-detail__button--small"
            onClick={() => setHiddenDates(new Set())}
          >
            全て表示
          </button>
          <button
            className="trip-detail__button trip-detail__button--small"
            onClick={() => setHiddenDates(new Set(segments.map(seg => seg.dateKey)))}
          >
            全て非表示
          </button>
          <button
            className="trip-detail__button trip-detail__button--small"
            onClick={() => fitBoundsRef.current?.()}
            disabled={segments.length === 0}
          >
            全体表示
          </button>
          <button
            className="trip-detail__button trip-detail__button--small"
            onClick={() => setUseMapMatching(v => !v)}
          >
            {useMapMatching ? '補正結果を非表示' : '補正結果を表示'}
          </button>
          <button
            className="trip-detail__button trip-detail__button--small"
            onClick={() => {
              void runCorrectionForVisibleSegments();
            }}
            disabled={
              matchingStatus === 'running' ||
              !useMapMatching ||
              !isOnline ||
              correctableVisibleSegments.length === 0 ||
              correctableVisibleSegments.every(seg => matchedBySegment[seg.segmentKey])
            }
          >
            表示中の補助ルートを補正
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 12, color: '#fff', marginBottom: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>日付ごとのルート</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          クリックで表示/非表示を切り替えできます。
        </div>
        {daySummaries.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {daySummaries.map(day => (
              <button
                key={day.dateKey}
                type="button"
                className="trip-detail__button trip-detail__button--small"
                onClick={() =>
                  setHiddenDates(prev => {
                    const next = new Set(prev);
                    if (next.has(day.dateKey)) {
                      next.delete(day.dateKey);
                    } else {
                      next.add(day.dateKey);
                    }
                    return next;
                  })
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                  opacity: hiddenDates.has(day.dateKey) ? 0.5 : 1,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: day.color, display: 'inline-block' }} />
                  <span>{day.dateLabel}</span>
                </span>
                <span style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
                  <span
                    style={{
                      padding: '4px 8px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 900,
                      ...qualityBadgeStyle(day.quality),
                    }}
                  >
                    {day.qualityLabel}
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.8, textAlign: 'right' }}>
                    {day.pointCount}点 / {day.displayDistanceKm.toFixed(1)}km
                    {day.gapCount > 0 ? ` / 分割 ${day.gapCount}` : ''}
                    {useMapMatching && day.providers.includes('osrm-match') ? ' / マッチ' : ''}
                    {useMapMatching && !day.providers.includes('osrm-match') && day.providers.includes('osrm-route') ? ' / 経路補完' : ''}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.68, textAlign: 'right' }}>
                    GPS {day.recordedPointCount}点 / 補助 {day.fallbackPointCount}点
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.68, textAlign: 'right' }}>
                    {day.qualityReason}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.8 }}>ルート記録がありません。イベント地点のみでも地図に出るよう補完しています。</div>
        )}
      </div>

      <div
        ref={mapRef}
        style={{
          width: '100%',
          height: '65vh',
          minHeight: 320,
          borderRadius: 16,
          overflow: 'hidden',
          background: '#0f172a',
          border: '1px solid rgba(148,163,184,0.2)',
        }}
      />
    </div>
  );
}
