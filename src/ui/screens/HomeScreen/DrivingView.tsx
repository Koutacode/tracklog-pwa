import React from 'react';
import ProgressGauge from '../../components/ProgressGauge';
import BigButton from '../../components/BigButton';
import type { LiveDriveStatus } from '../../../domain/liveDriveStatus';

type DrivingViewProps = {
  liveDrive: LiveDriveStatus;
  onVoiceCommand: () => void;
  voiceListening: boolean;
};

export const DrivingView: React.FC<DrivingViewProps> = ({
  liveDrive,
  onVoiceCommand,
  voiceListening,
}) => {
  const driveMinutes = liveDrive.driveSinceResetMinutes;
  const limit = 240; // 4 hours
  const emergencyLimit = 270; // 4.5 hours
  
  const gaugeColor = liveDrive.continuousDriveEmergencyExceeded
    ? '#ef4444'
    : liveDrive.continuousDriveExceeded
      ? '#f59e0b'
      : '#3b82f6';

  return (
    <div className="driving-view" style={{ display: 'grid', gap: 24, padding: '24px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <ProgressGauge
          value={driveMinutes}
          max={limit}
          label="連続運転時間"
          color={gaugeColor}
          size={240}
        />
      </div>

      <div className="card" style={{ padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)', marginBottom: 8 }}>
          {liveDrive.continuousDriveExceeded ? '休息・休憩が必要です' : '次の休憩まで'}
        </div>
        <div style={{ fontSize: 32, fontWeight: 900 }}>
          {liveDrive.continuousDriveExceeded 
            ? `超過 ${driveMinutes - limit}分`
            : `残り ${limit - driveMinutes}分`}
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
          （やむを得ない制限 4時間30分まで あと {emergencyLimit - driveMinutes}分）
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16 }}>
        <button
          onClick={onVoiceCommand}
          disabled={voiceListening}
          className="home-voice-button"
          style={{ height: 100, fontSize: 24 }}
        >
          {voiceListening ? '聞き取り中…' : '🎙 音声で操作'}
        </button>
        <p style={{ textAlign: 'center', fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
          「積込開始」「休憩開始」「地点マーク」などが使えます
        </p>
      </div>
    </div>
  );
};

export default DrivingView;
