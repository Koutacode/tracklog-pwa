/* Synthetic renderer integration. Never opens a microphone, browser or real DB. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const sourceRoot = process.env.TRACKLOG_VOICE_TEST_SOURCE || path.resolve(__dirname, '../../../..');
const dependencyRoot = process.env.TRACKLOG_VOICE_TEST_DEPS || sourceRoot;
const evidenceRoot = process.env.TRACKLOG_VOICE_TEST_EVIDENCE;
const testRequire = createRequire(path.join(dependencyRoot, 'package.json'));
const esbuild = testRequire('esbuild');
const React = testRequire('react');
const { act, create } = testRequire('react-test-renderer');
const fixtureKey = '__tracklogSyntheticVoiceFixture';
const outcomes = [];
const warnings = [];
let fixture;

const originals = new Map(['window', 'document', 'HTMLElement', 'alert', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', fixtureKey]
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const originalConsoleError = console.error;
console.error = (...args) => {
  const message = args.map(String).join(' ');
  warnings.push(message);
  if (!message.includes('react-test-renderer is deprecated')) originalConsoleError(...args);
};
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  document: { activeElement: null, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  HTMLElement: class {},
  window: {
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    confirm: () => { throw new Error('Unexpected extra confirmation'); },
  },
  alert: message => fixture.alerts.push(message),
  fetch: () => { throw new Error('Network forbidden in synthetic voice fixture'); },
});

const accessor = `const fixture=()=>globalThis.${fixtureKey};`;
const forbidden = `()=>{throw new Error('Out-of-scope native/remote action')}`;
const mocks = {
  '@capacitor/core': `export const Capacitor={isNativePlatform:()=>true,getPlatform:()=> 'android'};`,
  '@capacitor/app': `export const App={addListener:async()=>({remove:async()=>{}})};`,
  '@capacitor-community/speech-recognition': `${accessor}
    export const SpeechRecognition={
      available:async()=>({available:true}),
      checkPermissions:async()=>({speechRecognition:fixture().permission}),
      requestPermissions:async()=>{fixture().permissionRequests++;return {speechRecognition:fixture().requestedPermission}},
      isListening:async()=>({listening:false}),stop:async()=>{fixture().providerStops++},
      start:async options=>{fixture().providerStarts++;fixture().providerOptions.push(options);if(fixture().startError)throw fixture().startError;return fixture().speechDeferred?await fixture().speechDeferred.promise:{matches:fixture().matches}},
    };`,
  'react-router-dom': `${accessor}import React from 'react';
    export const Link=({to,children,...props})=>React.createElement('a',{...props,href:to},children);
    export const useLocation=()=>fixture().location;
    export const useNavigate=()=>()=>{throw new Error('Unexpected programmatic navigation')};`,
  'src/hooks/useTripManager.ts': `${accessor}export const useTripManager=()=>fixture().manager;`,
  'src/hooks/useComplianceMetrics.ts': `${accessor}export const useComplianceMetrics=()=>fixture().metrics;`,
  'src/hooks/useAdminEntryAvailability.ts': 'export const useAdminEntryAvailability=()=>false;',
  'src/ui/screens/HomeScreen/homeEventsRefresh.ts': 'export const subscribeHomeEventsChanged=()=>()=>{};',
  'src/db/repositories.ts': `${accessor}
    export const DEFAULT_ROUTE_TRACKING_MODE='balanced';
    export const getRouteTrackingMode=async()=>DEFAULT_ROUTE_TRACKING_MODE;
    export const getPendingExpresswayEndPrompt=async()=>fixture().pendingPrompt;
    export const getEventsByTripId=async()=>fixture().manager.events;
    export const clearPendingExpresswayEndDecision=async id=>fixture().auxiliary.push(['clearDecision',id]);
    export const clearPendingExpresswayEndPrompt=async id=>{fixture().auxiliary.push(['clearPrompt',id]);fixture().pendingPrompt=null};
    export const setRouteTrackingMode=${forbidden};`,
  'src/services/routeTracking.ts': `export const openNativeSettings=${forbidden};`,
  'src/services/nativeResidentLocation.ts': 'export const getNativeResidentLocationStatus=async()=>null;',
  'src/services/nativeExpresswayPromptDecision.ts': `${accessor}
    export const commitAutomaticExpresswayEnd=async params=>fixture().automatic.push(['end',params.prompt.tripId]);
    export const commitAutomaticExpresswayKeep=async params=>fixture().automatic.push(['keep',params.prompt.tripId]);`,
  'src/services/nativeExpresswayPrompt.ts': `${accessor}export const cancelNativeExpresswayEndPrompt=async id=>fixture().auxiliary.push(['cancelNativePrompt',id]);`,
  'src/services/startupDiagnostics.ts': 'export const runStartupDiagnostics=async()=>[];',
  'src/services/nativeSetup.ts': `export const checkNativeSetupReadiness=${forbidden},openAppPermissionSettings=${forbidden},openSystemLocationSettings=${forbidden},runNativeSetupStep=${forbidden};`,
  'src/services/appDistribution.ts': `export const copyLatestAndroidApkUrl=${forbidden};`,
  'src/app/routeTrackingSignal.ts': `${accessor}export const requestRouteTrackingSync=()=>{fixture().trackingSignals++};`,
  'src/app/breakToRestConfirmationSignal.ts': `${accessor}export const BREAK_TO_REST_MODAL_STATE_EVENT='synthetic-break-modal';export const isBreakToRestModalOpen=()=>fixture().breakModal;`,
  'src/ui/components/ProgressGauge.tsx': 'export default function ProgressGauge(){return null}',
  'src/ui/screens/HomeScreen/RunStatusCard.tsx': 'export default function RunStatusCard(){return null}',
  'src/ui/screens/HomeScreen/HomeAiSummaryCard.tsx': 'export default function HomeAiSummaryCard(){return null}',
  'src/ui/screens/HomeScreen/HomeBottomNav.tsx': 'export default function HomeBottomNav(){return null}',
};

function mockKey(request, directory) {
  if (Object.hasOwn(mocks, request)) return request;
  if (!request.startsWith('.')) return null;
  const relative = path.relative(sourceRoot, path.resolve(directory, request));
  return [relative, `${relative}.ts`, `${relative}.tsx`].find(key => Object.hasOwn(mocks, key)) ?? null;
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children ?? []).map(text).join('');
}
function button(renderer, label) {
  const matches = renderer.root.findAllByType('button').filter(node => text(node).replace(/^[🎙⛽⛴🔧]+/u, '') === label);
  assert.equal(matches.length, 1, `unique actual button: ${label}`);
  return matches[0];
}
function openDialogs(renderer) { return renderer.root.findAllByProps({ role: 'dialog' }); }
function activeOdo(renderer) {
  const matches = renderer.root.findAll(node => typeof node.type === 'function' && node.type.name === 'OdoDialog' && node.props.open);
  assert.equal(matches.length, 1, 'one actual OdoDialog is open');
  return matches[0];
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function click(node) { await act(async () => { await node.props.onClick(); await flush(); }); }
async function voice(renderer) {
  const control = button(renderer, '音声操作');
  assert.equal(control.props.disabled, false, 'voice is enabled after mocked native initialization');
  await click(control);
}
function noActions() {
  assert.deepEqual(fixture.calls, [], 'no trip-manager action reached');
  assert.deepEqual(fixture.automatic, [], 'no automatic expressway decision committed');
  assert.deepEqual(fixture.auxiliary, [], 'no pending/native state was changed');
  assert.equal(fixture.trackingSignals, 0);
}

function newFixture() {
  const state = {
    calls: [], automatic: [], auxiliary: [], alerts: [], trackingSignals: 0,
    permission: 'granted', requestedPermission: 'granted', permissionRequests: 0,
    providerStarts: 0, providerStops: 0, providerOptions: [], matches: [], startError: null,
    speechDeferred: null, operationDeferred: null, operationResult: true, pendingPrompt: null, breakModal: false,
    location: { pathname: '/', search: '', hash: '', key: 'synthetic-home' },
  };
  const record = name => async (...args) => {
    state.calls.push([name, ...args]);
    if (state.operationDeferred) await state.operationDeferred.promise;
    if (name === 'requestExpresswayEnd') return { status: 'completed' };
    if (name === 'captureGeoOnce') return { geo: { lat: 0, lng: 0 } };
    if (['handleStartTrip', 'handleEndTrip', 'handleStartRest', 'handleEndRest'].includes(name)) {
      return { id: 'synthetic-result', extras: { totalKm: 1 } };
    }
    return state.operationResult;
  };
  state.manager = {
    tripId: 'synthetic-voice-trip',
    events: [{ id: 'synthetic-start', tripId: 'synthetic-voice-trip', type: 'trip_start', ts: '2026-10-13T00:00:00.000Z', extras: { odoKm: 123400 }, syncStatus: 'synced' }],
    loading: false, geoStatus: null, geoError: null, activeOperation: null,
    operationInProgress: false, operationError: null,
    clearOperationError() {}, refresh: async () => {},
  };
  for (const name of ['captureGeoOnce', 'handleStartTrip', 'handleEndTrip', 'handleStartRest', 'handleEndRest', 'handleToggleEvent', 'handleStartExpressway', 'requestExpresswayEnd', 'handleAddRefuel', 'handleAddFerry', 'handleAddPointMark']) {
    state.manager[name] = record(name);
  }
  state.metrics = {
    now: Date.parse('2026-10-13T00:30:00.000Z'),
    liveVm: { segments: [], totalKm: 0, lastLegKm: 0, odoStart: 123400 }, activeDayMetrics: {},
    liveDrive: { currentCategory: 'idle', currentCategoryStartedAt: null, driveSinceResetMinutes: 30, remainingUntilLimitMinutes: 210, remainingUntilEmergencyLimitMinutes: 240, continuousDriveExceeded: false },
  };
  return state;
}
function addExpressway() {
  fixture.manager.events = [...fixture.manager.events, {
    id: 'synthetic-expressway', tripId: fixture.manager.tripId, type: 'expressway_start',
    ts: '2026-10-13T00:10:00.000Z', extras: { toggleSessionId: 'synthetic-expressway-session' }, syncStatus: 'synced',
  }];
}

async function main() {
  const bundled = await esbuild.build({
    absWorkingDir: sourceRoot, entryPoints: [path.join(sourceRoot, 'src/ui/screens/HomeScreen.tsx')],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    nodePaths: [path.join(dependencyRoot, 'node_modules')], external: ['react', 'react/jsx-runtime'], metafile: true,
    plugins: [{ name: 'synthetic-voice-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        const key = mockKey(args.path, args.resolveDir);
        return key ? { path: key, namespace: 'synthetic-voice' } : null;
      });
      build.onLoad({ filter: /.*/, namespace: 'synthetic-voice' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    }}],
  });
  const actualInputs = Object.keys(bundled.metafile.inputs).filter(name => !name.startsWith('synthetic-voice:'));
  assert.ok(actualInputs.includes('src/services/voiceControl.ts'), 'actual voice parser and recognition wrapper retained');
  assert.ok(actualInputs.includes('src/ui/components/OdoDialog.tsx'), 'actual confirmation component retained');
  assert.ok(actualInputs.includes('src/ui/screens/HomeScreen/StoppedView.tsx'), 'actual voice button retained');
  for (const input of actualInputs) {
    assert.ok(!input.startsWith('src/db/'), `real DB excluded: ${input}`);
    assert.ok(!input.startsWith('src/services/') || input === 'src/services/voiceControl.ts', `real remote/native services excluded: ${input}`);
  }
  const manifest = Object.fromEntries(actualInputs.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, name))).digest('hex')]));
  const module = { exports: {} };
  const execute = new vm.Script(`(function(require,module,exports){${bundled.outputFiles[0].text}\n})`, { filename: 'synthetic-home-voice.cjs' }).runInThisContext();
  execute(name => {
    assert.ok(['react', 'react/jsx-runtime'].includes(name), `unexpected runtime module ${name}`);
    return testRequire(name);
  }, module, module.exports);
  const HomeScreen = module.exports.default;

  async function check(name, configure, scenario) {
    fixture = newFixture();
    globalThis[fixtureKey] = fixture;
    configure?.();
    let renderer;
    const controller = {
      get renderer() { return renderer; },
      async rerender() { await act(async () => { renderer.update(React.createElement(HomeScreen)); await flush(); }); },
      async unmount() { if (renderer) await act(async () => { renderer.unmount(); renderer = null; await flush(); }); },
      async mount() { await act(async () => { renderer = create(React.createElement(HomeScreen)); await flush(); }); },
    };
    try {
      await controller.mount();
      await scenario(controller);
      outcomes.push({ name, status: 'passed', providerStarts: fixture.providerStarts, managerCalls: structuredClone(fixture.calls), automatic: structuredClone(fixture.automatic) });
    } finally {
      await controller.unmount();
    }
  }

  await check('permission_denied_zero_handler', () => { fixture.permission = 'denied'; }, async ({ renderer }) => {
    await voice(renderer); noActions(); assert.equal(fixture.providerStarts, 0);
    assert.equal(openDialogs(renderer).length, 0);
  });
  await check('permission_prompt_rejected_zero_handler', () => { fixture.permission = 'prompt'; fixture.requestedPermission = 'denied'; }, async ({ renderer }) => {
    await voice(renderer); noActions(); assert.equal(fixture.providerStarts, 0); assert.equal(fixture.permissionRequests, 1);
  });
  for (const [name, configure] of [
    ['silence', () => { fixture.matches = []; }],
    ['cancelled', () => { fixture.startError = new Error('Synthetic speech recognition cancelled'); }],
    ['interrupted', () => { fixture.startError = new Error('Synthetic speech recognition interrupted'); }],
    ['negative', () => { fixture.matches = ['運行終了しない123456']; }],
    ['multiple_commands', () => { fixture.matches = ['休憩開始と積込開始']; }],
    ['different_candidate_meanings', () => { fixture.matches = ['休憩開始', '積込開始']; }],
    ['different_candidate_odos', () => { fixture.matches = ['運行終了123456', '運行終了123457']; }],
    ['unsupported_mixed_unit_odo', () => { fixture.matches = ['運行終了12万3456']; }],
    ['decimal_odo', () => { fixture.matches = ['運行終了123456.7']; }],
    ['negative_odo', () => { fixture.matches = ['運行終了-123456']; }],
  ]) await check(`${name}_zero_handler`, configure, async ({ renderer }) => {
    await voice(renderer); noActions(); assert.equal(openDialogs(renderer).length, 0);
  });

  await check('trip_end_numeric_prefills_and_cancel_is_zero_handler', () => { fixture.matches = ['運行終了123456']; }, async ({ renderer }) => {
    await voice(renderer); noActions();
    assert.equal(activeOdo(renderer).props.initialValue, 123456);
    assert.equal(renderer.root.findByProps({ 'aria-label': 'オドメーター' }).props.value, '123456');
    await click(button(renderer, '戻る')); noActions(); assert.equal(openDialogs(renderer).length, 0);
  });
  await check('trip_end_numeric_confirm_once', () => { fixture.matches = ['運行終了123456']; }, async ({ renderer }) => {
    await voice(renderer); noActions();
    const form = activeOdo(renderer).findByType('form');
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); await flush(); });
    assert.deepEqual(fixture.calls, [['handleEndTrip', 123456]]);
  });
  await check('cancelled_odo_stale_submit_cannot_commit', () => { fixture.matches = ['運行終了123456']; }, async ({ renderer }) => {
    await voice(renderer); noActions();
    const staleSubmit = activeOdo(renderer).findByType('form').props.onSubmit;
    await click(button(renderer, '戻る'));
    await act(async () => { staleSubmit({ preventDefault() {} }); await flush(); });
    noActions();
  });
  await check('odo_confirmation_after_trip_change_cannot_commit', () => { fixture.matches = ['運行終了123456']; }, async controller => {
    await voice(controller.renderer); noActions();
    const staleSubmit = activeOdo(controller.renderer).findByType('form').props.onSubmit;
    fixture.manager.tripId = 'synthetic-replacement-trip';
    fixture.manager.events = fixture.manager.events.map(event => ({ ...event, tripId: fixture.manager.tripId }));
    await controller.rerender();
    await act(async () => { staleSubmit({ preventDefault() {} }); await flush(); });
    noActions();
  });
  await check('odo_confirmation_after_unmount_cannot_commit', () => { fixture.matches = ['運行終了123456']; }, async controller => {
    await voice(controller.renderer); noActions();
    const staleSubmit = activeOdo(controller.renderer).findByType('form').props.onSubmit;
    await controller.unmount();
    await act(async () => { staleSubmit({ preventDefault() {} }); await flush(); });
    noActions();
  });
  await check('trip_end_odo_can_be_corrected_before_confirm', () => { fixture.matches = ['運行終了123456']; }, async ({ renderer }) => {
    await voice(renderer); noActions();
    await click(button(renderer, 'C'));
    for (const digit of '123499') await click(renderer.root.findByProps({ 'aria-label': `${digit}を入力` }));
    noActions();
    await act(async () => { activeOdo(renderer).findByType('form').props.onSubmit({ preventDefault() {} }); await flush(); });
    assert.deepEqual(fixture.calls, [['handleEndTrip', 123499]]);
  });
  await check('rest_start_numeric_preserves_existing_immediate_action', () => { fixture.matches = ['休息開始123456']; }, async ({ renderer }) => {
    await voice(renderer);
    assert.deepEqual(fixture.calls, [['handleStartRest', 123456]]);
    assert.equal(openDialogs(renderer).length, 0);
  });
  await check('plain_command_executes_without_extra_confirmation', () => { fixture.matches = ['休憩開始']; }, async ({ renderer }) => {
    await voice(renderer);
    assert.deepEqual(fixture.calls, [['handleToggleEvent', 'break', 'start']]);
    assert.equal(openDialogs(renderer).length, 0);
  });
  await check('accepted_command_failure_remains_visible_after_operation_state_changes', () => {
    fixture.matches = ['休憩開始']; fixture.operationDeferred = deferred(); fixture.operationResult = false;
  }, async controller => {
    let pending;
    await act(async () => { pending = button(controller.renderer, '音声操作').props.onClick(); await flush(); });
    assert.deepEqual(fixture.calls, [['handleToggleEvent', 'break', 'start']]);
    fixture.manager.operationInProgress = true;
    fixture.manager.activeOperation = 'synthetic-break-start';
    await controller.rerender();
    await act(async () => { fixture.operationDeferred.resolve(); await pending; await flush(); });
    const feedback = controller.renderer.root.findAllByProps({ className: 'home-voice-feedback__error' });
    assert.equal(feedback.length, 1, 'accepted operation failure is still surfaced');
    assert.match(text(feedback[0]), /操作を完了できませんでした/);
    assert.equal(openDialogs(controller.renderer).length, 0);
  });
  await check('double_voice_press_has_one_listen_and_one_command', () => { fixture.speechDeferred = deferred(); }, async ({ renderer }) => {
    let first; let second;
    const press = button(renderer, '音声操作').props.onClick;
    await act(async () => { first = press(); second = press(); await flush(); });
    assert.equal(fixture.providerStarts, 1); noActions();
    await act(async () => { fixture.speechDeferred.resolve({ matches: ['休憩開始'] }); await Promise.all([first, second]); await flush(); });
    assert.deepEqual(fixture.calls, [['handleToggleEvent', 'break', 'start']]);
  });
  await check('double_odo_confirm_has_one_handler', () => { fixture.matches = ['運行終了123456']; fixture.operationDeferred = deferred(); }, async ({ renderer }) => {
    await voice(renderer); noActions();
    const submit = activeOdo(renderer).findByType('form').props.onSubmit;
    await act(async () => { submit({ preventDefault() {} }); submit({ preventDefault() {} }); await flush(); });
    assert.deepEqual(fixture.calls, [['handleEndTrip', 123456]]);
    await act(async () => { fixture.operationDeferred.resolve(); await flush(); });
  });
  for (const remount of [false, true]) await check(`late_result_after_${remount ? 'navigation_remount' : 'unmount'}_ignored`, () => { fixture.speechDeferred = deferred(); }, async controller => {
    let pending;
    await act(async () => { pending = button(controller.renderer, '音声操作').props.onClick(); await flush(); });
    assert.equal(fixture.providerStarts, 1);
    await controller.unmount();
    if (remount) {
      fixture.location = { pathname: '/', search: '', hash: '', key: 'synthetic-new-home' };
      await controller.mount();
    }
    await act(async () => { fixture.speechDeferred.resolve({ matches: ['休憩開始'] }); await pending; await flush(); });
    noActions();
    if (remount) assert.equal(openDialogs(controller.renderer).length, 0);
  });
  for (const [name, change] of [
    ['navigation_location_changed', () => { fixture.location = { pathname: '/history', search: '', hash: '', key: 'synthetic-history' }; }],
    ['trip_changed', () => { fixture.manager.tripId = 'synthetic-new-trip'; fixture.manager.events = fixture.manager.events.map(event => ({ ...event, tripId: 'synthetic-new-trip' })); }],
    ['operation_started', () => { fixture.manager.operationInProgress = true; fixture.manager.activeOperation = 'synthetic-pending-operation'; }],
    ['events_changed', () => { fixture.manager.events = [...fixture.manager.events, { id: 'synthetic-break', tripId: fixture.manager.tripId, type: 'break_start', ts: '2026-10-13T00:20:00.000Z', extras: { toggleSessionId: 'synthetic-break-session' }, syncStatus: 'synced' }]; }],
  ]) await check(`late_result_after_${name}_ignored`, () => { fixture.speechDeferred = deferred(); }, async controller => {
    let pending;
    await act(async () => { pending = button(controller.renderer, '音声操作').props.onClick(); await flush(); });
    change(); await controller.rerender();
    await act(async () => { fixture.speechDeferred.resolve({ matches: ['運行終了123456'] }); await pending; await flush(); });
    noActions(); assert.equal(openDialogs(controller.renderer).length, 0);
  });
  await check('late_result_after_state_changes_then_returns_is_ignored', () => { fixture.speechDeferred = deferred(); }, async controller => {
    let pending;
    await act(async () => { pending = button(controller.renderer, '音声操作').props.onClick(); await flush(); });
    fixture.manager.operationInProgress = true;
    fixture.manager.activeOperation = 'synthetic-temporary-operation';
    await controller.rerender();
    fixture.manager.operationInProgress = false;
    fixture.manager.activeOperation = null;
    await controller.rerender();
    await act(async () => { fixture.speechDeferred.resolve({ matches: ['運行終了123456'] }); await pending; await flush(); });
    noActions(); assert.equal(openDialogs(controller.renderer).length, 0);
  });
  await check('manual_expressway_end_still_uses_immediate_path', addExpressway, async ({ renderer }) => {
    const end = renderer.root.findAllByType('button').find(node => text(node).startsWith('高速道路終了'));
    assert.ok(end, 'manual expressway end button exists');
    await click(end);
    assert.deepEqual(fixture.calls, [['requestExpresswayEnd', 'manual_button']]);
    assert.equal(openDialogs(renderer).length, 0);
    assert.equal(fixture.auxiliary.length, 3);
  });
  await check('voice_expressway_end_still_uses_immediate_path', () => { addExpressway(); fixture.matches = ['高速道路終了']; }, async ({ renderer }) => {
    await voice(renderer);
    assert.deepEqual(fixture.calls, [['requestExpresswayEnd', 'voice']]);
    assert.equal(openDialogs(renderer).length, 0);
  });
  await check('automatic_expressway_still_waits_for_existing_confirmation', () => {
    addExpressway(); fixture.pendingPrompt = { tripId: fixture.manager.tripId, detectedAt: '2026-10-13T00:25:00.000Z', speedKmh: 0 };
  }, async ({ renderer }) => {
    assert.ok(text(renderer.root).includes('高速道路を降りましたか？'));
    noActions();
    await click(button(renderer, '終了してICを確定'));
    assert.deepEqual(fixture.calls, []);
    assert.deepEqual(fixture.automatic, [['end', 'synthetic-voice-trip']]);
  });

  const unexpectedWarnings = warnings.filter(message => !message.includes('react-test-renderer is deprecated'));
  assert.deepEqual(unexpectedWarnings, [], 'no unexpected React warnings');
  return {
    status: 'passed', scenarios: outcomes.length, outcomes, manifest,
    mockedBoundaries: Object.keys(mocks), frameworkWarnings: [...new Set(warnings)],
    testType: 'Synthetic React HomeScreen integration; provider and trip-manager boundaries mocked',
    realMicrophone: false, browserRun: false, androidRun: false, networkUsed: false,
    limitations: ['Handler invocation is evidence of intent routing, not a real DB transaction', 'ASR behavior and device permissions are simulated', 'No visual, focus, WebView or real-device validation'],
  };
}

main().then(result => {
  if (evidenceRoot) fs.writeFileSync(path.join(evidenceRoot, 'voice-ui-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`voiceInputSafety: ${result.scenarios} synthetic HomeScreen scenarios passed`);
}).catch(error => {
  if (evidenceRoot) fs.writeFileSync(path.join(evidenceRoot, 'voice-ui-result.json'), JSON.stringify({ status: 'failed', outcomes, error: String(error.stack ?? error), warnings }, null, 2) + '\n');
  originalConsoleError(error); process.exitCode = 1;
}).finally(() => {
  console.error = originalConsoleError;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
