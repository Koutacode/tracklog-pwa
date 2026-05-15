import React from 'react';
import BigButton from '../../components/BigButton';
import type { AppEvent } from '../../../domain/types';

type StoppedViewProps = {
  loadActive: boolean;
  unloadActive: boolean;
  breakActive: boolean;
  restActive: boolean;
  expresswayActive: boolean;
  ferryActive: boolean;
  canStartLoad: boolean;
  canStartUnload: boolean;
  canStartBreak: boolean;
  canStartRest: boolean;
  onOdoDialog: (kind: 'trip_end' | 'rest_start') => void;
  onToggle: (type: 'load' | 'unload' | 'break' | 'expressway', action: 'start' | 'end') => void;
  onRestEnd: () => void;
  onFerry: (action: 'boarding' | 'disembark') => void;
  onRefuel: () => void;
  onPointMark: () => void;
};

export const StoppedView: React.FC<StoppedViewProps> = ({
  loadActive,
  unloadActive,
  breakActive,
  restActive,
  expresswayActive,
  ferryActive,
  canStartLoad,
  canStartUnload,
  canStartBreak,
  canStartRest,
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
            onClick={() => onOdoDialog('trip_end')}
          />
          
          {loadActive ? (
            <BigButton label="積込終了" variant="neutral" onClick={() => onToggle('load', 'end')} />
          ) : (
            <BigButton label="積込開始" disabled={!canStartLoad} onClick={() => onToggle('load', 'start')} />
          )}

          {unloadActive ? (
            <BigButton label="荷卸終了" variant="neutral" onClick={() => onToggle('unload', 'end')} />
          ) : (
            <BigButton label="荷卸開始" disabled={!canStartUnload} onClick={() => onToggle('unload', 'start')} />
          )}

          {breakActive ? (
            <BigButton label="休憩終了" variant="neutral" onClick={() => onToggle('break', 'end')} />
          ) : (
            <BigButton label="休憩開始" disabled={!canStartBreak} onClick={() => onToggle('break', 'start')} />
          )}

          {restActive ? (
            <BigButton label="休息終了" variant="neutral" onClick={onRestEnd} />
          ) : (
            <BigButton label="休息開始（ODO）" disabled={!canStartRest} onClick={() => onOdoDialog('rest_start')} />
          )}
        </div>
      </div>

      <div className="card home-action-panel">
        <div className="home-section-label">補助操作</div>
        <div className="home-action-grid">
          <BigButton label="給油（数量）" size="compact" variant="neutral" onClick={onRefuel} />
          
          {expresswayActive ? (
            <BigButton label="高速道路終了" variant="neutral" size="compact" onClick={() => onToggle('expressway', 'end')} />
          ) : (
            <BigButton label="高速道路開始" size="compact" variant="neutral" onClick={() => onToggle('expressway', 'start')} />
          )}

          {ferryActive ? (
            <BigButton label="フェリー下船" size="compact" variant="neutral" onClick={() => onFerry('disembark')} />
          ) : (
            <BigButton label="フェリー乗船" size="compact" variant="neutral" onClick={() => onFerry('boarding')} />
          )}

          <BigButton label="地点マーク" size="compact" variant="neutral" onClick={onPointMark} />
        </div>
      </div>
    </div>
  );
};

export default StoppedView;
