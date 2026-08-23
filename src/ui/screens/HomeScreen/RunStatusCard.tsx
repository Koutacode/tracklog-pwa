import { Link } from 'react-router-dom';
import type { StartupDiagnosticItem } from '../../../services/startupDiagnostics';
import type { HomeStatusSummary } from './homeStatusModel';

type RunStatusCardProps = {
  route: HomeStatusSummary;
  expressway: HomeStatusSummary;
  location: HomeStatusSummary;
  diagnostics: HomeStatusSummary;
  diagnosticItems: StartupDiagnosticItem[];
  compact?: boolean;
  isAndroidNative: boolean;
  diagnosticsLoading: boolean;
  quickSetupRunning: boolean;
  quickSetupMessage: string | null;
  onRefreshDiagnostics: () => void;
  onQuickSetup: () => void;
};

function StatusLine(props: { item: HomeStatusSummary; primary?: boolean; hideDetail?: boolean }) {
  const { item, primary = false, hideDetail = false } = props;
  return (
    <div className={`home-runtime-status__item home-runtime-status__item--${item.tone}${primary ? ' home-runtime-status__item--primary' : ''}`}>
      <span className="home-runtime-status__icon" aria-hidden="true">{item.icon}</span>
      <span className="home-runtime-status__copy">
        <span className="home-runtime-status__label">{item.label}</span>
        <strong>{item.value}</strong>
        {!hideDetail && <small>{item.detail}</small>}
      </span>
    </div>
  );
}

export default function RunStatusCard(props: RunStatusCardProps) {
  const {
    route,
    expressway,
    location,
    diagnostics,
    diagnosticItems,
    compact = false,
    isAndroidNative,
    diagnosticsLoading,
    quickSetupRunning,
    quickSetupMessage,
    onRefreshDiagnostics,
    onQuickSetup,
  } = props;
  const needsSetup = diagnostics.tone === 'error'
    || route.tone === 'error'
    || route.tone === 'warning'
    || location.tone === 'error';
  const needsAttention = needsSetup
    || diagnostics.tone === 'warning'
    || expressway.tone === 'error'
    || expressway.tone === 'warning';
  const allDiagnosticIssues = diagnosticItems.filter(item => item.level !== 'ok');
  const diagnosticIssues = allDiagnosticIssues.slice(0, 2);
  const tripActive = route.value !== '未開始';
  const attentionDetail = route.tone === 'error' || route.tone === 'warning'
    ? route.detail
    : location.tone === 'error'
      ? location.detail
      : diagnostics.detail;

  return (
    <section className={`card home-runtime-status${compact ? ' home-runtime-status--compact' : ''}`} aria-labelledby="home-runtime-status-title">
      <div className="home-runtime-status__header">
        <div>
          <div className="home-section-label">運行サポート</div>
          <h2 id="home-runtime-status-title">いまの記録状態</h2>
        </div>
        <span className={`home-runtime-status__badge home-runtime-status__badge--${needsAttention ? 'attention' : 'ready'}`}>
          {needsAttention ? '! 要確認' : '✓ 正常'}
        </span>
      </div>

      {needsSetup && !compact && (
        <div className="home-runtime-status__attention" role="status">
          <strong>{tripActive ? '記録設定を確認してください' : '出発前に設定を確認してください'}</strong>
          <span>{attentionDetail}</span>
          <div className="home-runtime-status__actions">
            {isAndroidNative && (
              <button type="button" onClick={onQuickSetup} disabled={quickSetupRunning || diagnosticsLoading}>
                {quickSetupRunning ? '設定を確認中…' : 'かんたん設定'}
              </button>
            )}
            <Link to="/settings">設定を見る</Link>
          </div>
        </div>
      )}

      <div className="home-runtime-status__primary">
        <StatusLine item={route} primary hideDetail={route.value === '記録中'} />
        <StatusLine item={expressway} primary />
      </div>

      {!compact && (
        <div className="home-runtime-status__secondary">
          <StatusLine item={location} />
          <StatusLine item={diagnostics} />
        </div>
      )}

      {diagnosticIssues.length > 0 && !compact && (
        <div className="home-runtime-status__issues" aria-label="確認が必要な項目">
          {diagnosticIssues.map(item => (
            <span key={item.id}><strong>{item.label}</strong> {item.detail}</span>
          ))}
          {allDiagnosticIssues.length > diagnosticIssues.length && (
            <span>ほかの項目は「設定を見る」から確認できます。</span>
          )}
        </div>
      )}

      {!compact && (
        <div className="home-runtime-status__footer">
          <div className="home-runtime-status__footer-actions">
            <button type="button" onClick={onRefreshDiagnostics} disabled={diagnosticsLoading || quickSetupRunning}>
              {diagnosticsLoading ? '診断中…' : '再診断'}
            </button>
            {isAndroidNative && diagnostics.tone === 'warning' && (
              <button type="button" onClick={onQuickSetup} disabled={diagnosticsLoading || quickSetupRunning}>
                {quickSetupRunning ? '設定を確認中…' : 'かんたん設定'}
              </button>
            )}
          </div>
          {route.value === '記録中' && <span>{route.detail}</span>}
        </div>
      )}
      {compact && route.value === '記録中' && (
        <div className="home-runtime-status__footer home-runtime-status__footer--compact">
          <span>{route.detail}</span>
        </div>
      )}

      {quickSetupMessage && !compact && (
        <div className="home-runtime-status__message" role="status" aria-live="polite">
          {quickSetupMessage}
        </div>
      )}
    </section>
  );
}
