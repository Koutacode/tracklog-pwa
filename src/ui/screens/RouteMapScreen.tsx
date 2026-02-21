import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { listRoutePointsByTripId } from '../../db/repositories';
import type { RoutePoint } from '../../domain/types';
import { getJstDateInfo } from '../../domain/jst';
import { mapMatchRoutePoints, type LatLng } from '../../services/mapMatching';

const COLOR_PALETTE = ['#0ea5e9', '#22c55e', '#f97316', '#e11d48', '#a855f7', '#14b8a6', '#f59e0b', '#10b981'];

type RouteSegment = {
  dateKey: string;
  dateLabel: string;
  dayStamp: number;
  color: string;
  path: LatLng[];
  distanceKm: number;
  pointCount: number;
  startTs?: string;
  endTs?: string;
  points: RoutePoint[];
};

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
    .map(([dateKey, info], idx) => {
      const pts = [...info.points].sort((a, b) => a.ts.localeCompare(b.ts));
      let dist = 0;
      for (let i = 1; i < pts.length; i++) {
        dist += distanceMeters(pts[i - 1], pts[i]);
      }
      return {
        dateKey,
        dateLabel: info.dateLabel,
        dayStamp: info.dayStamp,
        color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
        path: pts.map(pt => ({ lat: pt.lat, lng: pt.lng })),
        distanceKm: Math.round((dist / 1000) * 10) / 10,
        pointCount: pts.length,
        startTs: pts[0]?.ts,
        endTs: pts[pts.length - 1]?.ts,
        points: pts,
      };
    })
    .sort((a, b) => a.dayStamp - b.dayStamp);
}

function distanceKm(path: LatLng[]) {
  let distM = 0;
  for (let i = 1; i < path.length; i++) {
    distM += distanceMeters(path[i - 1], path[i]);
  }
  return Math.round((distM / 1000) * 10) / 10;
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

export default function RouteMapScreen() {
  const { tripId } = useParams();
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenDates, setHiddenDates] = useState<Set<string>>(new Set());
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [useMapMatching, setUseMapMatching] = useState(true);
  const [matchingStatus, setMatchingStatus] = useState<'idle' | 'running' | 'done' | 'error' | 'offline'>('idle');
  const [matchedByDate, setMatchedByDate] = useState<Record<string, { path: LatLng[]; provider: 'osrm' | 'raw' }>>({});
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const fitBoundsRef = useRef<(() => void) | null>(null);

  const segments = useMemo(() => buildSegments(points), [points]);
  const displaySegments = useMemo(() => {
    return segments.map(seg => {
      if (!useMapMatching) {
        return {
          ...seg,
          displayPath: seg.path,
          displayDistanceKm: seg.distanceKm,
          matchProvider: 'raw' as const,
        };
      }
      const matched = matchedByDate[seg.dateKey];
      const path = matched?.path && matched.path.length >= 2 ? matched.path : seg.path;
      return {
        ...seg,
        displayPath: path,
        displayDistanceKm: distanceKm(path),
        matchProvider: matched?.provider ?? 'raw',
      };
    });
  }, [segments, matchedByDate, useMapMatching]);
  const visibleSegments = useMemo(
    () => displaySegments.filter(seg => !hiddenDates.has(seg.dateKey)),
    [displaySegments, hiddenDates],
  );
  const visiblePoints = useMemo(() => {
    if (hiddenDates.size === 0) return points;
    return points.filter(pt => !hiddenDates.has(getJstDateInfo(pt.ts).dateKey));
  }, [points, hiddenDates]);
  const totalDistanceKm = useMemo(() => {
    return displaySegments.reduce((sum, seg) => sum + seg.displayDistanceKm, 0);
  }, [displaySegments]);

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
        const arr = await listRoutePointsByTripId(tripId);
        if (cancelled) return;
        setPoints(arr);
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
    if (!useMapMatching) {
      setMatchedByDate({});
      setMatchingStatus('idle');
      return;
    }
    if (!isOnline) {
      setMatchedByDate({});
      setMatchingStatus('offline');
      return;
    }
    if (segments.length === 0) {
      setMatchedByDate({});
      setMatchingStatus('idle');
      return;
    }
    let cancelled = false;
    setMatchingStatus('running');
    void (async () => {
      const next: Record<string, { path: LatLng[]; provider: 'osrm' | 'raw' }> = {};
      for (const seg of segments) {
        if (seg.points.length < 2) continue;
        const matched = await mapMatchRoutePoints(seg.points);
        if (cancelled) return;
        next[seg.dateKey] = matched;
      }
      if (cancelled) return;
      setMatchedByDate(next);
      setMatchingStatus('done');
    })().catch(() => {
      if (!cancelled) {
        setMatchedByDate({});
        setMatchingStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [segments, useMapMatching, isOnline]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();
    const bounds = L.latLngBounds([]);

    for (const seg of visibleSegments) {
      if (seg.displayPath.length < 2) continue;
      const path = seg.displayPath.map(pt => L.latLng(pt.lat, pt.lng));
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
          <div>記録点: {points.length} 件 / 日数: {segments.length} 日</div>
          <div>推定距離: {totalDistanceKm.toFixed(1)} km {useMapMatching ? '(補正後)' : '(生データ)'}</div>
          <div>開始: {fmtDateTime(points[0]?.ts)} / 終了: {fmtDateTime(points[points.length - 1]?.ts)}</div>
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
            {useMapMatching ? '補正をOFF' : '補正をON'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 12, color: '#fff', marginBottom: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>日付ごとのルート</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
          クリックで表示/非表示を切り替えできます。
        </div>
        {segments.length > 0 ? (
          <div style={{ display: 'grid', gap: 8 }}>
            {displaySegments.map(seg => (
              <button
                key={seg.dateKey}
                type="button"
                className="trip-detail__button trip-detail__button--small"
                onClick={() =>
                  setHiddenDates(prev => {
                    const next = new Set(prev);
                    if (next.has(seg.dateKey)) {
                      next.delete(seg.dateKey);
                    } else {
                      next.add(seg.dateKey);
                    }
                    return next;
                  })
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'space-between',
                  opacity: hiddenDates.has(seg.dateKey) ? 0.5 : 1,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 999, background: seg.color, display: 'inline-block' }} />
                  <span>{seg.dateLabel}</span>
                </span>
                <span style={{ fontSize: 12, opacity: 0.8 }}>
                  {seg.pointCount}点 / {seg.displayDistanceKm.toFixed(1)}km
                  {useMapMatching && seg.matchProvider === 'osrm' ? ' (補正)' : ''}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.8 }}>ルート記録がありません。</div>
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
