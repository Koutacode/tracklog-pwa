import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getAdminTripBundle, deleteAdminTrip } from '../../services/remoteAdmin';

export default function AdminTripDetail() {
  const { tripId = '' } = useParams();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof getAdminTripBundle>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextBundle = await getAdminTripBundle(tripId);
        if (active) setBundle(nextBundle);
      } catch (err: any) {
        if (active) setError(err?.message ?? '運行詳細の取得に失敗しました');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [tripId]);

  if (!ready) return <div className="screen-shell"><div className="screen-card">読み込み中…</div></div>;
  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">運行詳細</div>
            <h1 className="screen-card__title">{tripId}</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/" className="pill-link">運転者画面へ戻る</Link>
            <button
              className="pill-link pill-link--danger"
              disabled={isDeleting}
              onClick={async () => {
                if (!window.confirm('この運行履歴を完全に削除しますか？\n\n関連する運行記録と日報データも削除されます。\n※この操作は元に戻せません。')) {
                  return;
                }
                setIsDeleting(true);
                try {
                  await deleteAdminTrip(tripId);
                  navigate(-1);
                } catch (e: any) {
                  setError(e?.message ?? '削除に失敗しました');
                  setIsDeleting(false);
                }
              }}
            >
              {isDeleting ? '削除中...' : 'この履歴を削除'}
            </button>
            <Link to="/admin" className="pill-link">一覧へ戻る</Link>
          </div>
        </div>
        {error && <div className="settings-toast">{error}</div>}
        <section className="settings-grid">
          <article className="card settings-panel">
            <div className="settings-panel__title">概要</div>
            <div className="settings-info-row"><span>状態</span><strong>{bundle?.header?.status ?? '-'}</strong></div>
            <div className="settings-info-row"><span>開始</span><strong>{bundle?.header?.start_ts ? new Date(bundle.header.start_ts).toLocaleString('ja-JP') : '-'}</strong></div>
            <div className="settings-info-row"><span>終了</span><strong>{bundle?.header?.end_ts ? new Date(bundle.header.end_ts).toLocaleString('ja-JP') : '-'}</strong></div>
            <div className="settings-info-row"><span>総距離</span><strong>{bundle?.header?.total_km ?? '-'} km</strong></div>
          </article>
          <article className="card settings-panel settings-panel--full">
            <div className="settings-panel__title">イベント時系列</div>
            <div className="admin-list">
              {(bundle?.events ?? []).map(event => (
                <div key={event.id} className="admin-list__item admin-list__item--static">
                  <strong>{new Date(event.ts).toLocaleString('ja-JP')}</strong>
                  <span>{event.type} {event.address ? ` / ${event.address}` : ''}</span>
                </div>
              ))}
            </div>
          </article>
          {bundle?.report && (
            <article className="card settings-panel settings-panel--full">
              <div className="settings-panel__title">日報スナップショット</div>
              <pre className="settings-code">{JSON.stringify(bundle.report.payload_json, null, 2)}</pre>
            </article>
          )}
        </section>
      </div>
    </div>
  );
}
