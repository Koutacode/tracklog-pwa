import React from 'react';

type ProgressGaugeProps = {
  value: number; // current value
  max: number;   // max value
  label: string;
  unit?: string;
  color?: string;
  size?: number;
};

export const ProgressGauge: React.FC<ProgressGaugeProps> = ({
  value,
  max,
  label,
  unit = '分',
  color = '#3b82f6',
  size = 120,
}) => {
  const percentage = Math.min(1, value / max);
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - percentage * circumference;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: size }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="#1e293b"
            strokeWidth={strokeWidth}
          />
          {/* Progress circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.5s ease' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            lineHeight: 1,
          }}
        >
          <span style={{ fontSize: size * 0.2, fontWeight: 800 }}>{value}</span>
          <span style={{ fontSize: size * 0.1, opacity: 0.7 }}>{unit}</span>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, textAlign: 'center' }}>{label}</div>
    </div>
  );
};

export default ProgressGauge;
