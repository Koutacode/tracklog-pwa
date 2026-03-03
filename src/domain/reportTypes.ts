export type TripEventType =
  | 'trip_start'
  | 'trip_end'
  | 'load_start'
  | 'load_end'
  | 'unload_start'
  | 'unload_end'
  | 'break_start'
  | 'break_end'
  | 'rest_start'
  | 'rest_end'
  | 'wait_start'
  | 'wait_end'
  | 'drive_start'
  | 'drive_end'
  | 'work_start'
  | 'work_end';

export type TripEvent = {
  type: TripEventType;
  ts: string; // ISO UTC
  address?: string;
  customer?: string;
  volume?: number; // M3
  memo?: string;
};

export type DayRecord = {
  dayIndex: number;
  dateKey: string;
  events: TripEvent[];
  km: number;
  odoStart: number;
  odoEnd: number;
  isFirstDay: boolean;
  tripStartMin: number | null;
  restStartMin: number | null;
  restPlace: string;
};

export type JobInfo = {
  id: string;
  customer: string;
  volume: number;
  loadAt: string;
  loadTime: string;
  dropAt: string;
  dropDate: string;
  isBranchDrop: boolean;
  completed: boolean;
};

export type Trip = {
  id: string;
  createdAt: string;
  label: string;
  days: DayRecord[];
  jobs: JobInfo[];
  rawJson: string;
};

export type DayMetrics = {
  constraintMinutes: number; // 拘束時間
  driveMinutes: number;      // 運転時間
  workMinutes: number;       // 運転以外の業務
  breakMinutes: number;      // 休憩
  restMinutes: number;       // 休息
  waitMinutes: number;       // 待機
  loadMinutes: number;       // 積込
  unloadMinutes: number;     // 荷卸
  constraintOverLimit: boolean;
  driveOverLimit: boolean;
  restUnderLimit: boolean;
  nextDriveRemaining: number; // 翌日残り運転(min)
  nextConstraintRemaining: number;
  earliestRestart: string | null; // ISO
  loads: LoadDetail[];
  unloads: LoadDetail[];
  alerts: ReportAlert[];
};

export type LoadDetail = {
  customer: string;
  volume: number;
  startTs: string;
  endTs: string;
  durationMinutes: number;
  address?: string;
};

export type ReportAlert = {
  level: 'warning' | 'danger';
  message: string;
};

export type MonthSummary = {
  month: string; // YYYY-MM
  totalTrips: number;
  totalDriveMinutes: number;
  totalWorkMinutes: number;
  totalBreakMinutes: number;
  totalRestMinutes: number;
  totalConstraintMinutes: number;
  totalKm: number;
  overConstraintDays: number;
  overDriveDays: number;
  underRestDays: number;
  days: Array<{
    dateKey: string;
    tripId: string;
    dayIndex: number;
    metrics: DayMetrics;
  }>;
};
