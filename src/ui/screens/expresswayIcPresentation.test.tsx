import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppEvent } from '../../domain/types';
import { getExpresswayIcDisplay } from '../../domain/expresswayIcDisplay';
import { mergeIcMetadata } from '../../domain/icMetadata';
import { buildReportTripFromAppEvents, computeTripDayMetrics, projectTripReportTimelines } from '../../domain/reportLogic';
import { buildTripViewModel } from '../../state/selectors';
import { buildTripAiSummaryPayload } from '../../services/tripAiSummary';
import { DailyView, getExpresswaySessions, TimelineView } from './ReportDashboard';
import { buildTripExpresswayHistorySummaries, formatTripExpresswayHistorySummary } from './historyExpresswaySummary';
import { buildTripDetailLocationInfo } from './tripDetailLocationInfo';
import { summarizeExpressway } from './HomeScreen/homeStatusModel';

Object.assign(globalThis, { __APP_VERSION__: '0.0.0-test', __BUILD_DATE__: 'synthetic-test' });

const estimate = {
  displayName: '合成北入口／合成南入口（推定候補）',
  candidateNames: ['合成北入口', '合成南入口'],
  certainty: 'ambiguous_candidates',
  source: 'saved_address_official_sources',
  note: '合成住所に基づく未確定候補。入口と進行方向は未確認。',
  sourceUrls: ['https://example.invalid/synthetic'],
  estimatedAt: '2026-09-01T00:00:00.000Z',
};

const catalogueEstimate = {
  ...estimate,
  displayName: '合成中央IC',
  candidateNames: ['合成中央IC', '合成第二IC'],
  source: 'mlit_n06_2025',
  sourceDatasetDate: '2025-12-31',
  estimatedAt: '2026-09-01T00:04:00.000Z',
};
const oldCatalogueEstimate = { ...catalogueEstimate, displayName: '過去合成IC', candidateNames: ['過去合成IC'],
  estimatedAt: '2026-09-01T00:01:00.000Z' };
const catalogueSupplementLabel = `${estimate.displayName} / 補助候補: 合成中央IC / 合成第二IC（国土数値情報・推定）`;
const mergedCatalogueExtras = mergeIcMetadata({
  icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'pending', icResolveAlgorithmVersion: 15,
}, {
  icName: catalogueEstimate.displayName, icNameEstimate: catalogueEstimate,
  icResolveStatus: 'resolved', icResolveAlgorithmVersion: 16,
}, { incomingIsNewer: true })!;

const cases: { name: string; extras: Record<string, unknown>; label: string; state: string }[] = [
  { name: 'no name pending', extras: { icResolveStatus: 'pending' },
    label: 'IC名未取得（取得中・取得待ち）', state: 'pending' },
  { name: 'failed attempt remains pending', extras: {
    icResolveStatus: 'pending', icResolveError: 'synthetic timeout', icResolveRetryCount: 2,
    icResolveNextRetryAt: '2026-09-01T01:00:00.000Z',
  }, label: 'IC名未取得（取得失敗・再取得待ち）', state: 'failed' },
  { name: 'saved multiple estimates remain pending', extras: {
    icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'pending',
  }, label: `${estimate.displayName} / 取得中・取得待ち`, state: 'estimated' },
  { name: 'saved single estimate remains pending', extras: {
    icName: '合成入口（推定）', icNameEstimate: { ...estimate, displayName: '合成入口（推定）',
      candidateNames: ['合成入口'], certainty: 'estimated' }, icResolveStatus: 'pending',
  }, label: '合成入口（推定） / 取得中・取得待ち', state: 'estimated' },
  { name: 'candidate metadata without top-level name', extras: {
    icNameEstimate: estimate, icResolveStatus: 'pending',
  }, label: `${estimate.displayName} / 取得中・取得待ち`, state: 'estimated' },
  { name: 'lookup candidate is not confirmed', extras: {
    icName: estimate.displayName, icNameEstimate: { ...estimate, source: 'overpass_nearby' }, icResolveStatus: 'resolved',
  }, label: `${estimate.displayName} / 未確定`, state: 'estimated' },
  { name: 'lookup representative does not hide alternative entrances', extras: {
    icName: '合成北入口', icNameEstimate: { ...estimate, displayName: '合成北入口', source: 'overpass_nearby' },
    icResolveStatus: 'resolved',
  }, label: '合成北入口 / 合成南入口（推定候補） / 未確定', state: 'estimated' },
  { name: 'confirmed name', extras: { icName: '合成確定IC', icResolveStatus: 'resolved' },
    label: '合成確定IC', state: 'resolved' },
  { name: 'manual with historic estimate and pending', extras: {
    icName: '合成手動IC', icNameEstimate: estimate, icResolveStatus: 'pending', icResolvedManually: true,
  }, label: '合成手動IC（手動修正）', state: 'manual' },
  { name: 'terminal communication failure', extras: { icResolveStatus: 'failed' },
    label: 'IC名未取得（取得失敗）', state: 'failed' },
  { name: 'retry resolved with retained historic evidence', extras: {
    icName: '合成解決IC', icNameEstimate: estimate, icResolveStatus: 'resolved',
  }, label: '合成解決IC', state: 'resolved' },
  { name: 'new catalogue result supplements the saved entrance candidates', extras: mergedCatalogueExtras,
    label: `${catalogueSupplementLabel} / 未確定`, state: 'estimated' },
  { name: 'latest catalogue history is selected by time and preserved after failure', extras: {
    icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'failed',
    icNameEstimateHistory: [catalogueEstimate, oldCatalogueEstimate,
      { ...oldCatalogueEstimate, source: 'overpass_nearby', estimatedAt: '2026-09-01T00:05:00.000Z' },
      { ...oldCatalogueEstimate, estimatedAt: 'invalid' }],
  }, label: `${catalogueSupplementLabel} / 取得失敗`, state: 'estimated' },
  { name: 'duplicate catalogue candidates are not repeated', extras: {
    icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'resolved',
    icNameEstimateHistory: [{ ...catalogueEstimate, candidateNames: estimate.candidateNames }],
  }, label: `${estimate.displayName} / 未確定`, state: 'estimated' },
  { name: 'empty latest catalogue does not resurrect stale alternatives', extras: {
    icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'resolved',
    icNameEstimateHistory: [oldCatalogueEstimate, { ...catalogueEstimate, candidateNames: [] }],
  }, label: `${estimate.displayName} / 未確定`, state: 'estimated' },
  { name: 'catalogue history does not replace a manual name', extras: {
    ...mergedCatalogueExtras, icName: '合成手動IC', icResolvedManually: true,
  }, label: '合成手動IC（手動修正）', state: 'manual' },
  { name: 'catalogue history does not annotate an independently confirmed name', extras: {
    ...mergedCatalogueExtras, icName: '合成確定IC',
  }, label: '合成確定IC', state: 'resolved' },
];

async function main() {
  const { DayReportSummary } = await import('./TripDetail');
  for (const fixture of cases) {
    const tripId = 'synthetic-presentation-trip';
    const highway: AppEvent = { id: 'synthetic-highway', tripId, type: 'expressway_start',
      ts: '2026-09-01T00:07:43.000Z', address: '合成市（その他）', syncStatus: 'synced',
      extras: { expresswaySessionId: 'synthetic-session', ...fixture.extras } };
    const events: AppEvent[] = [
      { id: 'synthetic-start', tripId, type: 'trip_start', ts: '2026-09-01T00:00:00.000Z',
        syncStatus: 'synced', extras: { odoKm: 100 } },
      highway,
    ];
    const before = structuredClone(events);
    const display = getExpresswayIcDisplay(highway.extras);
    assert.equal(display.label, fixture.label, fixture.name);
    assert.equal(display.state, fixture.state, fixture.name);
    assert.doesNotMatch(display.detail, /synthetic timeout/, 'technical errors are not driver-facing');
    assert.doesNotMatch(display.label, /過去合成IC/, 'older or unrelated catalogue evidence is not a current candidate');
    if (fixture.label.includes('補助候補')) {
      assert.ok(display.detail.includes('2025-12-31'), 'the supplementary source date is available in detail');
      assert.ok(display.detail.includes('入口・出口・進行方向は未確定'), 'supplementary catalogue names do not assert an entrance or direction');
    }

    const trip = buildReportTripFromAppEvents({ tripId, events, dayRuns: [] });
    const day = trip.days[0]!;
    const metrics = computeTripDayMetrics(trip)[0]!;
    const timeline = projectTripReportTimelines(trip.days).get(day.dayIndex)?.events ?? [];
    const item = buildTripDetailLocationInfo(timeline).find(value => value.expressway)!;
    assert.equal(item.icDisplay?.label, fixture.label);
    assert.equal(item.address, highway.address, 'address remains alongside the IC state');
    const standardHtml = renderToStaticMarkup(<DayReportSummary day={day} metrics={metrics}
      timeline={timeline} dayTimelines={[{ dayIndex: day.dayIndex, timeline }]} />);
    const reportHtml = renderToStaticMarkup(<DailyView day={day} metrics={metrics}
      expresswaySessions={getExpresswaySessions(trip.days).get(day.dayIndex) ?? []} />);
    const timelineHtml = renderToStaticMarkup(<TimelineView day={day} days={trip.days} />);
    for (const html of [standardHtml, reportHtml, timelineHtml]) {
      assert.ok(html.includes(fixture.label), `${fixture.name}: both reports and timeline display the IC state`);
    }

    const history = buildTripExpresswayHistorySummaries(events).get(tripId)!;
    assert.ok(formatTripExpresswayHistorySummary(history, { tripActive: true }).routeLabel.includes(fixture.label));
    assert.ok(summarizeExpressway(events, highway).value.includes(fixture.label));
    const vm = buildTripViewModel(tripId, events);
    assert.ok(vm.timeline.find(event => event.title === '高速道路')?.detail?.includes(fixture.label),
      'open highway output includes its IC name and state');
    const payload = buildTripAiSummaryPayload(tripId, vm, events, '2026-09-01T01:00:00.000Z');
    assert.ok(JSON.stringify(payload.timeline).includes(fixture.label), 'history output carries the same IC state');
    assert.deepEqual(events, before, 'display never changes timestamps, ODO, address, or estimate evidence');

    // A second endpoint must keep its independent candidate/state in paired output.
    const end: AppEvent = { ...highway, id: 'synthetic-end', type: 'expressway_end',
      ts: '2026-09-01T00:30:00.000Z', extras: { expresswaySessionId: 'synthetic-session',
        icName: '合成出口IC', icResolveStatus: 'resolved' } };
    const paired = buildTripViewModel(tripId, [...events, end]).timeline.find(event => event.title === '高速道路');
    assert.ok(paired?.detail?.includes(`高速開始IC: ${fixture.label} / 高速終了IC: 合成出口IC`),
      'entry and exit are independently represented');
  }
  console.log(`expresswayIcPresentation: ${cases.length} state cases across daily/detail/timeline/history/home/output passed`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
