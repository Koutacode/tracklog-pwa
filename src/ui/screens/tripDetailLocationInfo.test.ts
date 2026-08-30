import type { ProjectedReportTimelineEvent } from '../../domain/reportLogic';
import { buildTripDetailLocationInfo } from './tripDetailLocationInfo';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

const timeline: ProjectedReportTimelineEvent[] = [
  {
    event: {
      type: 'expressway_start',
      ts: '2026-08-30T01:00:00.000Z',
      address: '高速入口付近',
      extras: { icName: '札幌南IC' },
    },
    effectiveMinute: 600,
    effectiveTs: '2026-08-30T01:00:00.000Z',
  },
  {
    event: {
      type: 'expressway_end',
      ts: '2026-08-30T03:00:00.000Z',
      address: '高速出口付近',
      extras: { icName: '千歳IC' },
    },
    effectiveMinute: 720,
    effectiveTs: '2026-08-30T03:00:00.000Z',
  },
  {
    event: { type: 'load_start', ts: '2026-08-30T04:00:00.000Z', address: '荷主倉庫' },
    effectiveMinute: 780,
    effectiveTs: '2026-08-30T04:00:00.000Z',
  },
  {
    event: { type: 'drive_start', ts: '2026-08-30T05:00:00.000Z' },
    effectiveMinute: 840,
    effectiveTs: '2026-08-30T05:00:00.000Z',
  },
];

const info = buildTripDetailLocationInfo(timeline);
assertEqual(info.length, 3, 'expressway and addressed events remain visible');
assertEqual(info[0]?.label, '高速開始', 'expressway start is explicit');
assertEqual(info[0]?.time, '10:00', 'expressway start time');
assertEqual(info[0]?.icName, '札幌南IC', 'start IC remains visible');
assertEqual(info[1]?.label, '高速終了', 'expressway end is explicit');
assertEqual(info[1]?.icName, '千歳IC', 'end IC remains visible');
assertEqual(info[2]?.label, '積込開始地点', 'event address label');
assertEqual(info[2]?.address, '荷主倉庫', 'event address remains visible');

console.log('tripDetailLocationInfo: 8 assertions passed');
