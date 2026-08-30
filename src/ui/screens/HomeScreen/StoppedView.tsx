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
  onVoiceCommand: () => void;
  voiceAvailable: boolean;
  voiceListening: boolean;
  voiceLastText: string | null;
  voiceResult: string | null;
  voiceError: string | null;
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
  onVoiceCommand,
  voiceAvailable,
  voiceListening,
  voiceLastText,
  voiceResult,
  voiceError,
}) => {
  return (
    <div className="stopped-view home-unified-actions">
      <section className="home-action-panel" aria-labelledby="primary-actions-title">
        <h2 id="primary-actions-title" className="home-panel-title">よく使う操作</h2>
        <div className="home-primary-action-grid">
          {loadActive ? (
            <BigButton label="積込終了" variant="neutral" disabled={disabled} onClick={() => onToggle('load', 'end')} />
          ) : (
            <BigButton label="積込" disabled={disabled || !canStartLoad} onClick={() => onToggle('load', 'start')} />
          )}

          {unloadActive ? (
            <BigButton label="荷卸終了" variant="neutral" disabled={disabled} onClick={() => onToggle('unload', 'end')} />
          ) : (
            <BigButton label="荷卸" disabled={disabled || !canStartUnload} onClick={() => onToggle('unload', 'start')} />
          )}

          {breakActive ? (
            <BigButton label="休憩終了" variant="neutral" disabled={disabled} onClick={() => onToggle('break', 'end')} />
          ) : (
            <BigButton label="休憩" disabled={disabled || !canStartBreak} onClick={() => onToggle('break', 'start')} />
          )}

          {restActive ? (
            <BigButton label="休息終了" variant="neutral" disabled={disabled} onClick={onRestEnd} />
          ) : (
            <BigButton label="休息" disabled={disabled || !canStartRest} onClick={() => onOdoDialog('rest_start')} />
          )}
        </div>
      </section>

      <details className="home-secondary-actions">
        <summary>その他の操作</summary>
        <div className="home-secondary-action-grid">
          <button
            type="button"
            className="home-icon-action"
            onClick={onVoiceCommand}
            disabled={disabled || voiceListening || !voiceAvailable}
          >
            <span aria-hidden="true">🎙</span>
            {voiceListening ? '聞き取り中…' : voiceAvailable ? '音声操作' : '音声利用不可'}
          </button>
          <button type="button" className="home-icon-action" disabled={disabled} onClick={onRefuel}>
            <span aria-hidden="true">⛽</span>給油
          </button>

          {ferryActive ? (
            <button type="button" className="home-icon-action" disabled={disabled} onClick={() => onFerry('disembark')}>
              <span aria-hidden="true">⛴</span>フェリー下船
            </button>
          ) : (
            <button type="button" className="home-icon-action" disabled={disabled || !canStartFerry} onClick={() => onFerry('boarding')}>
              <span aria-hidden="true">⛴</span>フェリー乗船
            </button>
          )}

          <button type="button" className="home-icon-action" disabled={disabled} onClick={onPointMark}>
            <span aria-hidden="true">📍</span>地点記録
          </button>
        </div>
        {(voiceLastText || voiceResult || voiceError) && (
          <div className="home-voice-feedback" aria-live="polite">
            {voiceLastText && <span>認識: {voiceLastText}</span>}
            {voiceResult && <strong>{voiceResult}</strong>}
            {voiceError && <strong className="home-voice-feedback__error">{voiceError}</strong>}
          </div>
        )}
      </details>

      <BigButton
        label="運行を終了"
        hint="終了ODOを入力して確定"
        variant="danger"
        disabled={disabled}
        onClick={() => onOdoDialog('trip_end')}
      />
    </div>
  );
};

export default StoppedView;
