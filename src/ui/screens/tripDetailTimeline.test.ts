import type { ProjectedReportTimelineEvent } from '../../domain/reportLogic';
import type { TripEventType } from '../../domain/reportTypes';
import {
  buildTripDetailWorkTimeline,
  buildTripDetailWorkTimelineForDay,
  formatTripDetailWorkTimelineRow,
} from './tripDetailTimeline';

function projected(type: TripEventType, minute: number): ProjectedReportTimelineEvent {
  return {
    event: { type, ts: `2026-08-30T${String(Math.floor(minute / 60)).padStart(2, '0')}:00:00.000Z` },
    effectiveMinute: minute,
    effectiveTs: '2026-08-30T00:00:00.000Z',
  };
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

const rows = buildTripDetailWorkTimeline([
  projected('drive_start', 360),
  projected('drive_end', 600),
  projected('break_start', 615),
  projected('break_end', 660),
  projected('load_start', 660),
  projected('load_end', 720),
  projected('rest_start', 1200),
]);

assertEqual(rows.length, 3, 'driving events are excluded while work sessions remain');
assertEqual(rows[0]?.label, '休憩', 'paired work label');
assertEqual(rows[0]?.startMinute, 615, 'paired work start');
assertEqual(rows[0]?.endMinute, 660, 'paired work end');
assertEqual(rows[2]?.label, '休息', 'open work label');
assertEqual(rows[2]?.endMinute, undefined, 'open work has no false end');
const openLabels = formatTripDetailWorkTimelineRow(rows[2]!);
assertEqual(openLabels.startLabel, '開始 20:00', 'start label is explicit');
assertEqual(openLabels.endLabel, '終了 進行中', 'open end label is explicit');
assertEqual(openLabels.durationLabel, '作業時間 継続中', 'open duration is explicit');

const closedLabels = formatTripDetailWorkTimelineRow(rows[0]!);
assertEqual(closedLabels.startLabel, '開始 10:15', 'closed start label is explicit');
assertEqual(closedLabels.endLabel, '終了 11:00', 'closed end label is explicit');
assertEqual(closedLabels.durationLabel, '作業時間 45分', 'closed duration is explicit');

const carry = buildTripDetailWorkTimeline([projected('rest_end', 480)]);
assertEqual(carry[0]?.startMinute, 0, 'day-spanning work begins at the day boundary');
assertEqual(carry[0]?.endMinute, 480, 'day-spanning work retains its end');
assertEqual(carry[0]?.continuesFromPreviousDay, true, 'day-spanning work is labelled as continued');

const sameTime = buildTripDetailWorkTimeline([
  projected('wait_start', 300),
  projected('wait_end', 300),
]);
assertEqual(sameTime[0]?.startMinute, 300, 'same-time start is preserved');
assertEqual(sameTime[0]?.endMinute, 300, 'same-time end is preserved');

const spanningDays = [
  { dayIndex: 1, timeline: [projected('rest_start', 1200)] },
  { dayIndex: 2, timeline: [] },
  { dayIndex: 3, timeline: [projected('rest_end', 480)] },
];
const firstDay = buildTripDetailWorkTimelineForDay(spanningDays, 1)[0];
assertEqual(firstDay?.startMinute, 1200, 'start day keeps the actual start');
assertEqual(firstDay?.endMinute, 1440, 'closed multi-day work clips the start day at 24:00');
assertEqual(firstDay?.continuesToNextDay, true, 'start day is labelled as continuing');
const middleDay = buildTripDetailWorkTimelineForDay(spanningDays, 2)[0];
assertEqual(middleDay?.startMinute, 0, 'event-free middle day begins at 00:00');
assertEqual(middleDay?.endMinute, 1440, 'event-free middle day ends at 24:00');
assertEqual(middleDay?.continuesFromPreviousDay, true, 'middle day shows previous-day continuity');
assertEqual(middleDay?.continuesToNextDay, true, 'middle day shows next-day continuity');
const lastDay = buildTripDetailWorkTimelineForDay(spanningDays, 3)[0];
assertEqual(lastDay?.startMinute, 0, 'end day clips the start to 00:00');
assertEqual(lastDay?.endMinute, 480, 'end day keeps the actual end');

const ongoingDays = [
  { dayIndex: 1, timeline: [projected('break_start', 1200)] },
  { dayIndex: 2, timeline: [] },
];
assertEqual(
  buildTripDetailWorkTimelineForDay(ongoingDays, 1)[0]?.endMinute,
  1440,
  'an earlier day never displays a cross-midnight interval as currently ongoing',
);
assertEqual(
  buildTripDetailWorkTimelineForDay(ongoingDays, 2)[0]?.endMinute,
  undefined,
  'only the last day displays a truly open interval as ongoing',
);
assertEqual(
  buildTripDetailWorkTimelineForDay(ongoingDays, 2)[0]?.continuesToNextDay,
  false,
  'a truly ongoing last-day interval does not falsely claim a next-day continuation',
);

console.log('tripDetailTimeline: 30 assertions passed');
