import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppEvent } from '../../domain/types';
import type { HistoryDay } from './tripHistoryReport';
import { formatTripDayEventTime, getTripDayMunicipality, TripDayReport } from './TripDayReport';

function event(type: AppEvent['type'], index: number, extras?: Record<string, unknown>): AppEvent {
  return { id: `synthetic-${index}`, tripId: 'synthetic-day-report', type,
    ts: '2026-10-01T00:03:27.001Z', syncStatus: 'synced', extras };
}

function day(events: AppEvent[]): HistoryDay {
  return {
    dayIndex: 1, dateKey: '2026-10-01', startMinute: 540, endMinute: 645,
    segments: [
      { startMinute: 540, endMinute: 555, category: 'drive' },
      { startMinute: 555, endMinute: 570, category: 'work' },
      { startMinute: 570, endMinute: 585, category: 'break' },
      { startMinute: 585, endMinute: 600, category: null },
      { startMinute: 600, endMinute: 630, category: 'ferry' },
      { startMinute: 630, endMinute: 645, category: 'rest' },
    ],
    totals: { drive: 15, work: 15, break: 15, ferry: 30, rest: 15 },
    unknownMinutes: 15, ongoing: false, events,
    effectiveMinutes: Object.fromEntries(events.map(item => [item.id, 540])),
    effectiveTimestamps: Object.fromEntries(events.map(item => [item.id, '2026-10-01T00:00:00.000Z'])),
  };
}

const boundaryTypes: AppEvent['type'][] = [
  'trip_start', 'trip_end', 'load_start', 'load_end', 'unload_start', 'unload_end',
  'break_start', 'break_end', 'rest_start', 'rest_end', 'boarding', 'disembark',
  'work_start', 'work_end', 'expressway_start', 'expressway_end',
];
const boundaries = boundaryTypes.map((type, index) => event(type, index));
const source = day(boundaries);
const before = structuredClone(source);
const html = renderToStaticMarkup(<TripDayReport day={source} km={1234} />);
assert.equal((html.match(/data-event-id=/g) ?? []).length, 16, 'all 16 boundaries survive even at the same saved time');
assert.equal((html.match(/場所未確認/g) ?? []).length, 16, 'addressless boundaries remain explicit');
for (const boundary of boundaryTypes) assert.ok(html.includes(`data-event-type="${boundary}"`), boundary);
for (const label of ['高速入口', '高速出口', '積込開始', '積込終了', '荷卸し開始', '荷卸し終了', 'フェリー乗船', 'フェリー下船']) {
  assert.ok(html.includes(label), `${label} remains visible`);
}
assert.ok(html.includes('IC名未取得（未確定）'), 'unknown IC names are visible without inventing a name');
assert.equal((html.match(/data-category-total=/g) ?? []).length, 5, 'exactly five category totals are shown');
assert.equal((html.match(/class="trip-report-grid__line/g) ?? []).length, 103, 'the chart includes all 96 quarter-hour slots and row borders');
assert.equal((html.match(/data-category="/g) ?? []).length, 5, 'an unknown interval does not acquire a category');
assert.ok(html.includes('合計 1:30'), 'visible total comes from classified minutes');
assert.ok(html.includes('未確認 0:15'), 'unknown duration remains separately visible');
assert.ok(html.includes('1,234'), 'distance retains Japanese number formatting');
assert.ok(html.includes('09:00</time>'), 'saved 09:03 displays the nearest quarter hour');
assert.ok(html.includes('dateTime="2026-10-01T00:03:27.001Z"'), 'the exact saved timestamp is preserved');
assert.deepEqual(source, before, 'rendering does not modify events, addresses, source extras or graph data');
assert.equal((html.match(/class="trip-report-axis__hour"/g) ?? []).length, 5, 'overview labels remain readable on a narrow phone');
for (const hour of [0, 6, 12, 18, 24]) assert.ok(html.includes(`>${String(hour).padStart(2, '0')}</span>`));
assert.ok(html.includes('trip-report-grid--overview'), 'a day opens with its complete 24-hour overview');
assert.ok(html.includes('aria-pressed="true" aria-controls="history-chart-1">全体表示</button>'));
assert.ok(html.includes('aria-pressed="false" aria-controls="history-chart-1">拡大表示</button>'));
assert.equal((html.match(/trip-report-grid__line--hour/g) ?? []).length, 25, 'each hour has a major line with three quarter-hour subdivisions');
assert.ok(html.includes('role="region" aria-label="24時間の全体表示"'), 'overview has an accessible name without an unnecessary scroll tab stop');
assert.ok(html.indexOf('class="trip-report-axis"') > html.indexOf('class="trip-report-grid__scroll"'), 'axis and plot belong to the same scroll viewport');
assert.ok(html.includes('24時間を表示 · 区間をタップして拡大'));


assert.equal(formatTripDayEventTime(1440), '24:00');
assert.equal(formatTripDayEventTime(0), '00:00');
assert.equal(formatTripDayEventTime(555), '09:15');
assert.equal(formatTripDayEventTime(Number.NaN), '時刻未確認');
assert.equal(formatTripDayEventTime(undefined), '時刻未確認');
assert.equal(formatTripDayEventTime(-1), '時刻未確認');
assert.equal(formatTripDayEventTime(1455), '時刻未確認');

const shifted = day([{ ...event('load_end', 100), ts: '2026-09-30T15:01:00.000Z' }]);
shifted.effectiveMinutes['synthetic-100'] = 15;
const shiftedHtml = renderToStaticMarkup(<TripDayReport day={shifted} />);
assert.ok(shiftedHtml.includes('>00:15</time>'), 'the model minimum-duration projection wins over raw 00:01');
assert.ok(shiftedHtml.includes('dateTime="2026-09-30T15:01:00.000Z"'), 'projected display preserves the raw timestamp');

for (const [address, expected] of [
  ['北海道札幌市白石区中央1条1丁目', '北海道札幌市白石区'],
  ['千葉県市川市高谷3丁目', '千葉県市川市'],
  ['千葉県市川市市川1丁目', '千葉県市川市'],
  ['千葉県市原市姉崎', '千葉県市原市'],
  ['三重県四日市市日永', '三重県四日市市'],
  ['石川県野々市市三納', '石川県野々市市'],
  ['東京都町田市原町田', '東京都町田市'],
  ['東京都千代田区丸の内1丁目', '東京都千代田区'],
  ['京都府京都市伏見区横大路', '京都府京都市伏見区'],
  ['北海道余市郡余市町黒川町', '北海道余市郡余市町'],
  ['長野県北佐久郡軽井沢町長倉', '長野県北佐久郡軽井沢町'],
  ['〒060-0001 北海道札幌市中央区北一条', '北海道札幌市中央区'],
]) assert.equal(getTripDayMunicipality(address), expected, address);
assert.equal(getTripDayMunicipality('合成倉庫'), undefined, 'an unrecognized saved place is not fabricated into a municipality');
assert.equal(getTripDayMunicipality('中央市場倉庫'), undefined, 'a facility name containing 市 is not shortened into a city');
assert.equal(getTripDayMunicipality('山梨県市川三郷町市川大門'), undefined, 'an ambiguous municipality boundary safely retains the original address');
assert.equal(getTripDayMunicipality('   '), undefined);

const estimate = { displayName: '合成北入口', candidateNames: ['合成北入口', '合成南入口'], source: 'saved_address_official_sources' };
const described: AppEvent[] = [
  { ...event('expressway_start', 1, { icName: '合成北入口', icNameEstimate: estimate, icResolveStatus: 'pending' }), address: '北海道札幌市白石区中央1条' },
  event('expressway_end', 2, { icName: '合成出口', icResolvedManually: true }),
  { ...event('load_start', 3), address: '<img src=x onerror=alert(1)>' },
  event('load_end', 4),
  event('refuel', 5, { liters: 40 }),
  event('refuel', 6, { liters: -1 }),
  event('point_mark', 7),
];
const describedHtml = renderToStaticMarkup(<TripDayReport day={day(described)} />);
assert.ok(describedHtml.includes('合成北入口 / 合成南入口（推定候補） / 取得中・取得待ち'));
assert.ok(describedHtml.includes('推定候補のため未確定です。'), 'IC uncertainty guidance remains available in the disclosure');
assert.ok(describedHtml.includes('合成出口（手動修正）'), 'manual edits retain their origin');
assert.ok(describedHtml.includes('北海道札幌市白石区</div>'));
assert.ok(describedHtml.includes('保存住所：北海道札幌市白石区中央1条'), 'the complete saved address remains in details');
assert.ok(describedHtml.includes('&lt;img'), 'unrecognized saved addresses are escaped');
assert.ok(!describedHtml.includes('<img'), 'an address cannot add HTML');
assert.ok(describedHtml.includes('40 L'));
assert.ok(!describedHtml.includes('-1 L'));
assert.equal((describedHtml.match(/data-event-id=/g) ?? []).length, 7, 'zero-length work, refuel and point records remain visible');

const empty = { ...day([]), segments: [], totals: { drive: 0, work: 0, break: 0, ferry: 0, rest: 0 }, unknownMinutes: 0 };
const emptyHtml = renderToStaticMarkup(<TripDayReport day={empty} />);
assert.ok(emptyHtml.includes('この日の記録はありません'));
assert.ok(!emptyHtml.includes('data-event-id='));
assert.ok(!emptyHtml.includes('NaN'));

console.log('TripDayReport: five-row graph, 16 boundaries, quarter-hour labels, municipalities and source evidence passed');
