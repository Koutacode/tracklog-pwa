import { renderToStaticMarkup } from 'react-dom/server';
import type { DayRecord, TripEvent } from '../../domain/reportTypes';
import {
  getReportTimelineRefuelDetail,
  TimelineView,
} from './ReportDashboard';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function luminance(hex: string): number {
  const channels = hex.replace('#', '').match(/.{2}/g)?.map(channel => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`invalid color: ${hex}`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function makeRefuelEvent(liters: unknown): TripEvent {
  return {
    type: 'refuel',
    ts: '2026-09-04T00:00:00.000Z',
    extras: { liters },
  };
}

function makeDay(event: TripEvent): DayRecord {
  return {
    dayIndex: 1,
    dateKey: '2026-09-04',
    events: [event],
    km: 0,
    odoStart: 0,
    odoEnd: 0,
    isFirstDay: true,
    tripStartMin: null,
    restStartMin: null,
    restPlace: '',
  };
}

const validRefuel = makeRefuelEvent(40);
const refuelColor: string = '#facc15';
assertEqual(
  getReportTimelineRefuelDetail(validRefuel),
  '給油量: 40.0 L',
  'whole-number liters use stable Japanese formatting',
);
assert(
  contrastRatio(refuelColor, '#0b1220') >= 4.5,
  'refuel label meets WCAG AA text contrast against the report background',
);
assert(refuelColor !== '#f59e0b', 'refuel color remains distinguishable from break events');

const validDay = makeDay(validRefuel);
const validHtml = renderToStaticMarkup(<TimelineView day={validDay} days={[validDay]} />);
assert(validHtml.includes('給油'), 'timeline renders the refuel label');
assert(validHtml.includes('給油量: 40.0 L'), 'timeline renders valid refuel liters');
assert(validHtml.includes(`color:${refuelColor}`), 'timeline applies the refuel color');

for (const invalidLiters of [undefined, null, '40', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  assertEqual(
    getReportTimelineRefuelDetail(makeRefuelEvent(invalidLiters)),
    undefined,
    'invalid liters do not invent a displayed amount',
  );
}

const invalidDay = makeDay(makeRefuelEvent('40'));
const invalidHtml = renderToStaticMarkup(<TimelineView day={invalidDay} days={[invalidDay]} />);
assert(invalidHtml.includes('給油'), 'timeline still renders refuel when liters are invalid');
assert(!invalidHtml.includes('給油量'), 'timeline omits an invalid refuel amount');

console.log('reportDashboardTimeline: refuel presentation and rendering assertions passed');
