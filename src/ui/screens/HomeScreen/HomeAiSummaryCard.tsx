import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { listTrips, type TripSummary } from '../../../db/repositories';
import TripAiSummaryAction from '../../components/TripAiSummaryAction';

type Props = {
  activeTripId?: string | null;
  activeStartTs?: string;
  disabled?: boolean;
  dialogBlocked?: boolean;
};

function formatStart(ts?: string) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export default function HomeAiSummaryCard({ activeTripId, activeStartTs, disabled, dialogBlocked }: Props) {
  const [latestTrip, setLatestTrip] = useState<TripSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLatestTrip(null);
    setLoading(true);
    setLoadFailed(false);
    if (activeTripId) return;
    const subscription = liveQuery(listTrips).subscribe({
      next: trips => {
        setLatestTrip(trips.find(trip => trip.status === 'closed') ?? null);
        setLoading(false);
        setLoadFailed(false);
      },
      error: () => {
        setLatestTrip(null);
        setLoading(false);
        setLoadFailed(true);
      },
    });
    return () => subscription.unsubscribe();
  }, [activeTripId]);

  const targetId = activeTripId || latestTrip?.tripId;
  const targetLabel = activeTripId
    ? '現在の運行'
    : latestTrip
      ? `直近の運行 · ${formatStart(latestTrip.startTs)}`
      : loadFailed
        ? '履歴を読み込めませんでした'
        : loading ? '運行履歴を読み込み中…' : '運行を記録すると利用できます';

  return (
    <section className="home-ai-summary" aria-label="運行のAI要約">
      <div className="home-ai-summary__copy">
        <strong>{targetLabel}</strong>
        <span>{activeTripId && activeStartTs ? `${formatStart(activeStartTs)}開始 · ` : ''}AIに貼り付けるデータをコピー</span>
      </div>
      <TripAiSummaryAction
        tripId={targetId}
        disabled={disabled || !targetId}
        dialogBlocked={dialogBlocked}
        className="home-ai-summary__button"
      />
    </section>
  );
}
