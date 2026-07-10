import React from 'react';
import BigButton from '../../components/BigButton';

type StoppedViewProps = {
  disabled: boolean;
  loadActive: boolean;
  unloadActive: boolean;
  breakActive: boolean;
  restActive: boolean;
  ferryActive: boolean;
  canStartLoad: boolean;
  canStartUnload: boolean;
  canStartBreak: boolean;
  canStartRest: boolean;
  canStartFerry: boolean;
  onOdoDialog: (kind: 'trip_end' | 'rest_start') => void;
  onToggle: (type: 'load' | 'unload' | 'break', action: 'start' | 'end') => void;
  onRestEnd: () => void;
  onFerry: (action: 'boarding' | 'disembark') => void;
  onRefuel: () => void;
  onPointMark: () => void;
};

export const StoppedView: React.FC<StoppedViewProps> = ({
  disabled,
  loadActive,
  unloadActive,
  breakActive,
  restActive,
  ferryActive,
  canStartLoad,
  canStartUnload,
  canStartBreak,
  canStartRest,
  canStartFerry,
  onOdoDialog,
  onToggle,
  onRestEnd,
  onFerry,
  onRefuel,
  onPointMark,
}) => {
  return (
    <div className="stopped-view" style={{ display: 'grid', gap: 14 }}>
      <div className="card home-action-panel">
        <div className="home-section-label">主要操作</div>
        <div className="home-actions">
          <BigButton
            label="運行終了"
            hint="終了ODOを入力して確定"
            variant="danger"
            disabled={disabled}
            onClick={() => onOdoDialog('trip_end')}
          />
          
          {loadActive ? (
            <BigButton label="積込終了" variant="neutral" disabled={disabled} onClick={() => onToggle('load', 'end')} />
          ) : (
            <BigButton label="積込開始" disabled={disabled || !canStartLoad} onClick={() => onToggle('load', 'start')} />
          )}

          {unloadActive ? (
            <BigButton label="荷卸終了" variant="neutral" disabled={disabled} onClick={() => onToggle('unload', 'end')} />
          ) : (
            <BigButton label="荷卸開始" disabled={disabled || !canStartUnload} onClick={() => onToggle('unload', 'start')} />
          )}

          {breakActive ? (
            <BigButton label="休憩終了" variant="neutral" disabled={disabled} onClick={() => onToggle('break', 'end')} />
          ) : (
            <BigButton label="休憩開始" disabled={disabled || !canStartBreak} onClick={() => onToggle('break', 'start')} />
          )}

          {restActive ? (
            <BigButton label="休息終了" variant="neutral" disabled={disabled} onClick={onRestEnd} />
          ) : (
            <BigButton label="休息開始（ODO）" disabled={disabled || !canStartRest} onClick={() => onOdoDialog('rest_start')} />
          )}
        </div>
      </div>

      <div className="card home-action-panel">
        <div className="home-section-label">補助操作</div>
        <div className="home-action-grid">
          <BigButton label="給油（数量）" size="compact" variant="neutral" disabled={disabled} onClick={onRefuel} />

          {ferryActive ? (
            <BigButton label="フェリー下船" size="compact" variant="neutral" disabled={disabled} onClick={() => onFerry('disembark')} />
          ) : (
            <BigButton label="フェリー乗船" size="compact" variant="neutral" disabled={disabled || !canStartFerry} onClick={() => onFerry('boarding')} />
          )}

          <BigButton label="地点マーク" size="compact" variant="neutral" disabled={disabled} onClick={onPointMark} />
        </div>
      </div>
    </div>
  );
};

export default StoppedView;
