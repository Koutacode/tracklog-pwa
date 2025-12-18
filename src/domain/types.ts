export type EventType =
  | 'trip_start'
  | 'trip_end'
  | 'rest_start'
  | 'rest_end'
  | 'break_start'
  | 'break_end'
  | 'load_start'
  | 'load_end'
  | 'refuel'
  | 'boarding'
  | 'expressway'
  | 'expressway_start'
  | 'expressway_end';

export type Geo = {
  lat: number;
  lng: number;
  accuracy?: number;
};

export type BaseEvent = {
  id: string;
  tripId: string;
  type: EventType;
  ts: string; // ISO timestamp
  geo?: Geo;
  address?: string;
  syncStatus: 'pending' | 'synced' | 'error';
  extras?: Record<string, unknown>;
};

export type TripStartEvent = BaseEvent & {
  type: 'trip_start';
  extras: { odoKm: number };
};

export type TripEndEvent = BaseEvent & {
  type: 'trip_end';
  extras: { odoKm: number; totalKm: number; lastLegKm: number };
};

export type RestStartEvent = BaseEvent & {
  type: 'rest_start';
  extras: { restSessionId: string; odoKm: number };
};

export type RestEndEvent = BaseEvent & {
  type: 'rest_end';
  extras: { restSessionId: string; dayClose: boolean; dayIndex?: number };
};

export type AppEvent =
  | TripStartEvent
  | TripEndEvent
  | RestStartEvent
  | RestEndEvent
  | BaseEvent;

export type Segment = {
  index: number;
  fromLabel: string;
  toLabel: string;
  fromOdo: number;
  toOdo: number;
  km: number;
  valid: boolean;
  fromTs?: string;
  toTs?: string;
  restSessionIdTo?: string;
};

export type DayRun = {
  dayIndex: number;
  fromLabel: string;
  toLabel: string;
  km: number;
  status: 'confirmed' | 'pending';
};

export type TimelineItem = {
  ts: string;
  title: string;
  detail?: string;
};
