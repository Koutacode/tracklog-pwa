import assert from 'node:assert/strict';
import { scrubSentryBreadcrumb, scrubSentryEvent } from './sentryPrivacy';

let assertions = 0;
const checkEqual: typeof assert.equal = assert.equal;
const checkOk: typeof assert.ok = assert.ok;
const checkDeepEqual: typeof assert.deepEqual = assert.deepEqual;
assert.equal = ((...args: Parameters<typeof assert.equal>) => {
  assertions += 1;
  return checkEqual(...args);
}) as typeof assert.equal;
assert.ok = ((...args: Parameters<typeof assert.ok>) => {
  assertions += 1;
  return checkOk(...args);
}) as typeof assert.ok;
assert.deepEqual = ((...args: Parameters<typeof assert.deepEqual>) => {
  assertions += 1;
  return checkDeepEqual(...args);
}) as typeof assert.deepEqual;

const SYNTHETIC_LAT = '35.000100';
const SYNTHETIC_LNG = '139.000100';
const SYNTHETIC_ADDRESS = '神奈川県横浜市';
const SYNTHETIC_IC = '合成厚木IC';
const SYNTHETIC_IP = '203.0.113.5';

const sensitiveEvent = {
  message: `同期に失敗しました ${SYNTHETIC_ADDRESS} ${SYNTHETIC_IC} ${SYNTHETIC_LAT},${SYNTHETIC_LNG}`,
  level: 'error',
  release: 'tracklog-assist@0.1.95',
  server_name: 'synthetic-device',
  user: { id: 'driver-1', ip_address: SYNTHETIC_IP },
  request: { url: `https://example.test/path?lat=${SYNTHETIC_LAT}&lng=${SYNTHETIC_LNG}`, headers: { cookie: 'secret' } },
  extra: { note: 'keep-me-not', icName: SYNTHETIC_IC },
  extras: { address: SYNTHETIC_ADDRESS, latitude: 35.0001, longitude: 139.0001 },
  contexts: { device: { name: 'synthetic-device', model: 'Pixel' }, geo: { lat: 35.0001, lng: 139.0001 } },
  tags: { area: 'sync', icName: SYNTHETIC_IC, device_name: 'synthetic-device' },
  exception: {
    values: [{
      type: 'TypeError',
      value: `出口 ${SYNTHETIC_IC} ${SYNTHETIC_ADDRESS} ${SYNTHETIC_IP} ${SYNTHETIC_LAT}`,
    }],
  },
  breadcrumbs: [
    { category: 'console', message: `console ${SYNTHETIC_LAT}` },
    { category: 'fetch', type: 'http', data: { url: `https://example.test/?lat=${SYNTHETIC_LAT}` } },
    { category: 'xhr', type: 'http', data: { url: 'https://example.test/xhr' } },
    { category: 'navigation', data: { to: `/map?lng=${SYNTHETIC_LNG}` } },
    {
      category: 'ui.click',
      message: `ボタン ${SYNTHETIC_IC}`,
      data: {
        address: SYNTHETIC_ADDRESS,
        icName: SYNTHETIC_IC,
        latitude: 35.0001,
        url: 'https://example.test/path?lat=35.01&lng=139.02',
      },
    },
  ],
};

function assertNoSensitiveText(value: unknown, label: string) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SYNTHETIC_LAT), false, `${label} に緯度が残っています`);
  assert.equal(text.includes(SYNTHETIC_LNG), false, `${label} に経度が残っています`);
  assert.equal(text.includes('35.01'), false, `${label} に URL の緯度が残っています`);
  assert.equal(text.includes('139.02'), false, `${label} に URL の経度が残っています`);
  assert.equal(text.includes(SYNTHETIC_ADDRESS), false, `${label} に住所が残っています`);
  assert.equal(text.includes('神奈川県'), false, `${label} に都道府県が残っています`);
  assert.equal(text.includes(SYNTHETIC_IC), false, `${label} に IC 名が残っています`);
  assert.equal(text.includes(SYNTHETIC_IP), false, `${label} に IP が残っています`);
  assert.equal(text.includes('synthetic-device'), false, `${label} にデバイス名が残っています`);
}

const scrubbedEvent = scrubSentryEvent(sensitiveEvent);
assert.ok(scrubbedEvent, '座標を消したあともエラーイベントは残す');
assertNoSensitiveText(scrubbedEvent, 'イベント');
assert.equal(scrubbedEvent.level, 'error');
assert.equal(scrubbedEvent.release, 'tracklog-assist@0.1.95');
assert.equal(scrubbedEvent.message?.includes('同期に失敗しました'), true, '位置以外のメッセージは残す');
assert.equal(scrubbedEvent.exception?.values?.[0]?.type, 'TypeError');
assert.equal(scrubbedEvent.exception?.values?.[0]?.value?.includes('出口'), true);
assert.equal(scrubbedEvent.tags?.area, 'sync');
assert.equal(scrubbedEvent.extra, undefined);
assert.equal(scrubbedEvent.extras, undefined);
assert.equal(scrubbedEvent.contexts, undefined);
assert.equal(scrubbedEvent.user, undefined);
assert.equal(scrubbedEvent.request, undefined);
assert.equal(scrubbedEvent.server_name, undefined);
assert.equal(scrubbedEvent.tags?.icName, undefined);
assert.equal(scrubbedEvent.tags?.device_name, undefined);
assert.equal(scrubbedEvent.breadcrumbs?.length, 1);
assert.equal(scrubbedEvent.breadcrumbs?.[0]?.category, 'ui.click');
assert.equal(scrubbedEvent.breadcrumbs?.[0]?.data?.address, undefined);
assert.equal(scrubbedEvent.breadcrumbs?.[0]?.data?.icName, undefined);
assert.equal(scrubbedEvent.breadcrumbs?.[0]?.data?.latitude, undefined);
assert.equal(String(scrubbedEvent.breadcrumbs?.[0]?.data?.url).includes('lat=[filtered]'), true);
assert.equal(String(scrubbedEvent.breadcrumbs?.[0]?.data?.url).includes('lng=[filtered]'), true);

for (const kind of ['console', 'fetch', 'xhr', 'navigation', 'history', 'http'] as const) {
  assert.equal(
    scrubSentryBreadcrumb({ category: kind, message: `${kind} ${SYNTHETIC_ADDRESS} ${SYNTHETIC_IC} ${SYNTHETIC_LAT}` }),
    null,
    `${kind} ブレッドクラムは種類ごと捨てる`,
  );
}

assert.equal(scrubSentryBreadcrumb({ type: 'http', category: 'custom', message: SYNTHETIC_LAT }), null, 'http 種別のブレッドクラムは捨てる');

const keptBreadcrumb = scrubSentryBreadcrumb({
  category: 'ui.click',
  message: `操作 ${SYNTHETIC_IC} ${SYNTHETIC_ADDRESS}`,
  data: { url: `https://example.test/item?latitude=${SYNTHETIC_LAT}&longitude=${SYNTHETIC_LNG}`, geo: { lat: 35.0001 } },
});
assert.ok(keptBreadcrumb, '画面操作のブレッドクラムは残す');
assertNoSensitiveText(keptBreadcrumb, 'ブレッドクラム');
assert.equal(keptBreadcrumb.category, 'ui.click');
assert.equal(keptBreadcrumb.message?.includes('操作'), true);
assert.equal(keptBreadcrumb.data?.geo, undefined);

assert.equal(scrubSentryEvent({ type: 'transaction', message: 'trace' }), null, '性能イベントは送らない');
assert.equal(scrubSentryEvent({ type: 'replay_event', message: 'replay' }), null, 'Replay イベントは送らない');
assert.equal(scrubSentryEvent({ type: 'profile', message: 'profile' }), null, 'プロファイルイベントは送らない');
assert.equal(
  scrubSentryEvent({ message: 'バージョン 0.1.95 の同期に失敗しました' })?.message,
  'バージョン 0.1.95 の同期に失敗しました',
);

const plain = scrubSentryEvent({ message: 'データベースの更新に失敗しました', exception: { values: [{ type: 'Error', value: 'データベースの更新に失敗しました' }] } });
assert.equal(plain?.message, 'データベースの更新に失敗しました');
assert.equal(plain?.exception?.values?.[0]?.value, 'データベースの更新に失敗しました');

const keptDetail = 'バージョン 0.1.95 で 12件失敗 2026-11-12T13:58:13Z 00:11 index.ts:128:4 行番号 42';
const coordinateShape = scrubSentryEvent({
  message: `${keptDetail} 出口 35.681,139.767 と 35.68 139.76 と 35.6 横浜市港北区大豆戸町1丁目2番3号`,
  frames: { lineno: 128, colno: 4 },
  point: { x: 35.681, y: 139.767, note: '地点' },
  path: [139.767, 35.681, 12],
  pair: { latitude: 35.68, longitude: 139.76 },
});
const coordinateMessage = coordinateShape?.message ?? '';
assert.equal(coordinateMessage.includes(keptDetail), true, '版・件数・時刻・行番号は残す');
assert.equal(coordinateMessage.includes('35.681'), false);
assert.equal(coordinateMessage.includes('139.767'), false);
assert.equal(coordinateMessage.includes('35.68'), false);
assert.equal(coordinateMessage.includes('139.76'), false);
assert.equal(coordinateMessage.includes('35.6'), false);
assert.equal(coordinateMessage.includes('横浜市'), false);
assert.equal(coordinateMessage.includes('港北区'), false);
assert.equal(coordinateMessage.includes('大豆戸町'), false);
assert.equal(coordinateMessage.includes('1丁目'), false);
assert.equal(coordinateMessage.includes('2番3号'), false);
assert.equal(coordinateShape?.frames?.lineno, 128);
assert.equal(coordinateShape?.frames?.colno, 4);
assert.equal(coordinateShape?.point?.x, undefined);
assert.equal(coordinateShape?.point?.y, undefined);
assert.equal(coordinateShape?.point?.note, '地点');
assert.deepEqual(coordinateShape?.path, ['[filtered]', 12]);
assert.equal(coordinateShape?.pair?.latitude, undefined);
assert.equal(coordinateShape?.pair?.longitude, undefined);
assert.equal(JSON.stringify(coordinateShape).includes('35.681'), false);
assert.equal(JSON.stringify(coordinateShape).includes('139.767'), false);

const fullwidthEvent = scrubSentryEvent({
  message: [
    'バージョン０．１．９５',
    '失敗１２件',
    '時刻１３：５８',
    'ｉｎｄｅｘ．ｔｓ：１２８：４',
    '座標４０．０００１',
    '［１４０．０００１，４０．０００１］',
    '中黒４０・０００１',
    'ハイフン４０－０００１',
    '空白４０．０００１　１４０．０００１',
    '混在架空市40．0001',
    '架空市架空区九十九町一丁目二番地三号',
    '〒９９９－００００',
    '０９０－００００－００００',
  ].join(' '),
  'ｌａｔ': '４０．０００１',
  'ｌｎｇ': '１４０．０００１',
});
const fullwidthMessage = fullwidthEvent?.message ?? '';
for (const kept of ['0.1.95', '12件', '13:58', 'index.ts:128:4']) {
  assert.equal(fullwidthMessage.includes(kept), true, `全角で書かれた ${kept} は半角で残す`);
}
for (const leaked of [
  '４０', '４０．０００１', '40.0001', '１４０', '140.0001',
  '架空市', '架空区', '九十九町', '一丁目', '1丁目', '二番地', '2番地', '三号',
  '９９９', '999-0000', '０９０', '090-0000-0000', '-0000', '0000',
]) {
  assert.equal(fullwidthMessage.includes(leaked), false, `全角の位置情報が残っています: ${leaked}`);
}
assert.equal(fullwidthEvent?.['ｌａｔ'], undefined);
assert.equal((fullwidthEvent as { lat?: unknown } | null)?.lat, undefined);
assert.equal(fullwidthEvent?.['ｌｎｇ'], undefined);

function assertScrubbed(input: string, removed: string[], kept: string[]) {
  const output = scrubSentryEvent({ message: input })?.message ?? '';
  for (const value of removed) {
    assert.equal(output.includes(value), false, `消えるべきものが残っています: ${value}`);
    assert.equal(output.includes(value.normalize('NFKC')), false, `NFKC 後も残っています: ${value}`);
  }
  for (const value of kept) {
    assert.equal(output.includes(value), true, `残すものがありません: ${value}`);
  }
  return output;
}

assertScrubbed(
  '集計999 バージョン０．１．９５ 失敗１２件 〒９９９００００ 〒９９９　００００ ０９０００００００００ ０９０　００００　００００',
  ['〒９９９００００', '〒9990000', '〒９９９　００００', '〒999 0000', '０９０００００００００', '09000000000', '０９０　００００　００００', '090 0000 0000'],
  ['集計999', '0.1.95', '12件'],
);
assertScrubbed(
  '句点は残す。 バージョン０．１．９５ ４０。０００１ と 40。0001',
  ['４０。０００１', '40。0001', '40.0001'],
  ['句点は残す。', '0.1.95'],
);
assertScrubbed(
  '比率12.50 バージョン０．１．９５ ４０．００００ と １４０．００００００',
  ['４０．００００', '40.0000', '１４０．００００００', '140.000000'],
  ['比率12.50', '0.1.95'],
);
assertScrubbed(
  '番地1-2-3 は消す １１－１２－１３ バージョン０．１．９５ 失敗１２件 時刻１３：５８ ｉｎｄｅｘ．ｔｓ：１２８：４',
  ['1-2-3'],
  ['11-12-13', '0.1.95', '12件', '13:58', 'index.ts:128:4'],
);

const deviceEvent = scrubSentryEvent({
  device: {
    '緯度': '４０。０００１',
    model: '架空端末',
    note: '残すメモ',
  },
});
assert.equal(deviceEvent?.device?.['緯度'], undefined, 'NFKC した装置キーは残さない');
assert.equal(JSON.stringify(deviceEvent?.device).includes('40.0001'), false);
assert.equal(JSON.stringify(deviceEvent?.device).includes('４０。０００１'), false);
assert.equal(deviceEvent?.device?.model, '架空端末');
assert.equal(deviceEvent?.device?.note, '残すメモ');

async function main() {
  Object.assign(globalThis, {
    __APP_VERSION__: '0.1.95',
    __BUILD_DATE__: 'test',
  });
  const sentry = await import('./sentry');
  const calls: Array<Parameters<typeof sentry.initTracklogSentry>[0]> = [];
  const init = (options: unknown) => {
    calls.push(options as Parameters<typeof sentry.initTracklogSentry>[0]);
  };

  assert.equal(sentry.initTracklogSentry({ dsn: undefined, init }), false, 'DSN が無いときは初期化しない');
  assert.equal(sentry.initTracklogSentry({ dsn: '', init }), false, '空の DSN では初期化しない');
  assert.equal(sentry.initTracklogSentry({ dsn: '   ', init }), false, '空白の DSN では初期化しない');
  assert.equal(sentry.initTracklogSentry({ init }), false, '環境変数 VITE_SENTRY_DSN が無いときは初期化しない');
  assert.equal(calls.length, 0);

  const placeholderDsn = 'https://public@o0.ingest.sentry.io/0';
  assert.equal(sentry.initTracklogSentry({
    dsn: placeholderDsn,
    release: 'tracklog-assist@0.1.95',
    environment: 'production',
    init,
  }), true);

  assert.equal(calls.length, 1);
  const options = calls[0] as ReturnType<typeof sentry.buildTracklogSentryOptions>;
  assert.equal(options.dsn, placeholderDsn);
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.sendClientReports, false);
  assert.equal(options.release, 'tracklog-assist@0.1.95');
  assert.equal(options.environment, 'production');
  assert.equal(Object.prototype.hasOwnProperty.call(options, 'tracesSampleRate'), false, 'tracesSampleRate は設定しない');
  assert.equal(options.tracesSampler, undefined);
  assert.equal(options.enableLogs, false);
  assert.equal(options.profileSessionSampleRate, 0);
  assert.equal(options.replaysSessionSampleRate, 0);
  assert.equal(options.replaysOnErrorSampleRate, 0);
  assert.equal(options.beforeSendTransaction?.({ type: 'transaction' } as never, {}), null);
  assert.equal(options.beforeSendLog?.({} as never), null);
  assert.equal(options.beforeSendMetric?.({} as never), null);
  assert.equal(options.dataCollection?.userInfo, false);
  assert.equal(options.dataCollection?.urlQueryParams, false);
  assert.equal(options.dataCollection?.stackFrameVariables, false);
  assert.deepEqual(TRACKLOG_DISABLED_EXPECTATION, sentry.TRACKLOG_DISABLED_BREADCRUMB_SOURCES);

  assert.equal(typeof options.integrations, 'function');
  if (typeof options.integrations !== 'function') throw new Error('integrations が関数ではありません');
  const integrations = options.integrations([
    { name: 'GlobalHandlers' },
    { name: 'Breadcrumbs' },
    { name: 'BrowserSession' },
    { name: 'HttpContext' },
    { name: 'Replay' },
    { name: 'BrowserTracing' },
    { name: 'BrowserProfiling' },
    { name: 'WebVitals' },
  ]);
  assert.deepEqual(integrations.map(integration => integration.name).sort(), ['Breadcrumbs', 'GlobalHandlers']);
  assert.equal(integrations.some(integration => integration.name === 'BrowserSession'), false, 'BrowserSession は残さない');

  const hint = { attachments: [{ filename: 'note.txt', data: '35.681,139.767 横浜市' }] };
  const scrubbedByCallback = options.beforeSend?.(sensitiveEvent as never, hint);
  assert.deepEqual(hint.attachments, []);
  assert.ok(scrubbedByCallback);
  assertNoSensitiveText(scrubbedByCallback, 'beforeSend');
  assert.equal(options.beforeBreadcrumb?.({ category: 'console', message: SYNTHETIC_LAT }, {}), null);
  assert.equal(options.beforeBreadcrumb?.({ category: 'navigation', data: { to: SYNTHETIC_ADDRESS } }, {}), null);
  const scrubbedBreadcrumb = options.beforeBreadcrumb?.({
    category: 'ui.click',
    message: `${SYNTHETIC_IC} ${SYNTHETIC_LAT}`,
  }, {});
  assert.ok(scrubbedBreadcrumb);
  assertNoSensitiveText(scrubbedBreadcrumb, 'beforeBreadcrumb');
  console.log(`sentry privacy assertions: ${assertions}`);
}

const TRACKLOG_DISABLED_EXPECTATION = {
  console: false,
  dom: false,
  fetch: false,
  history: false,
  sentry: false,
  xhr: false,
};

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
