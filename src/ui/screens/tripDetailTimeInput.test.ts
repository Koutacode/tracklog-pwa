import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { commitTripDetailOperationalMutation } from './tripDetailOperationalMutation';
import { parseFuelInput } from '../components/fuelInput';
import { parseJapanTimeInput, resolveTripDetailTimeEdit, toJapanTimeInput } from './tripDetailTimeInput';

const fixtures = [
  ['2026-10-12T01:30Z', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
  ['2026-10-12T01:30:45.678901Z', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
  ['2026-10-12T10:30+0900', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
  ['2026-10-12T01:30:45.678Z', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
  ['2026-10-11T14:59:59.999Z', '2026-10-11T23:59', '2026-10-11T14:59:00.000Z'],
  ['2026-10-11T15:00:00.000Z', '2026-10-12T00:00', '2026-10-11T15:00:00.000Z'],
  ['2026-03-31T15:00:00.000Z', '2026-04-01T00:00', '2026-03-31T15:00:00.000Z'],
  ['2026-12-31T15:00:00.000Z', '2027-01-01T00:00', '2026-12-31T15:00:00.000Z'],
  ['2028-02-28T15:00:00.000Z', '2028-02-29T00:00', '2028-02-28T15:00:00.000Z'],
  ['2026-10-12T10:30:45.678+09:00', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
  ['2026-10-11T18:30:00-07:00', '2026-10-12T10:30', '2026-10-12T01:30:00.000Z'],
] as const;

const invalidInputs = [
  '', 'invalid', '2026-10-12T10:30\n', '2026-02-30T10:30', '2026-02-29T10:30', '2026-04-31T10:30',
  '2026-00-12T10:30', '2026-13-12T10:30', '2026-10-00T10:30',
  '2026-10-12T24:00', '2026-10-12T10:60', '0000-01-01T00:00',
  '2026-10-12', '2026-10-12 10:30', '2026-1-12T10:30',
  '2026-10-12T10:30:00', '2026-10-12T10:30Z', '2026-10-12T10:30+09:00',
  ' 2026-10-12T10:30', '2026-10-12T10:30 ', '２０２６-１０-１２T１０:３０',
];
const invalidTimestamps = [
  '', 'invalid', '2026-10-12T01:30:00.000Z\n', '2026-02-30T01:30:00.000Z', '2026-10-12T24:00:00.000Z',
  '2026-10-12T01:30:60.000Z', '2026-10-12T01:30:00', '2026-10-12',
  '2026-10-12T01:30:00+24:00', '2026-10-12T01:30:00+09:60',
];

const originalTimezone = process.env.TZ;
const localOffsets = new Set<number>();
try {
  for (const timezone of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
    process.env.TZ = timezone;
    localOffsets.add(new Date('2026-10-12T01:30:00.000Z').getTimezoneOffset());
    for (const [original, input, minuteIso] of fixtures) {
      assert.equal(toJapanTimeInput(original), input, `${timezone}: Japan-time initial display`);
      assert.equal(parseJapanTimeInput(input), minuteIso, `${timezone}: explicit Japan-time parsing`);
      assert.deepEqual(resolveTripDetailTimeEdit(original, input), { kind: 'unchanged', iso: original },
        `${timezone}: unchanged edit preserves the complete original timestamp`);
      assert.equal(resolveTripDetailTimeEdit(original, input.slice(0, 15) + (input.endsWith('0') ? '1' : '0')).kind, 'changed',
        `${timezone}: supported restored ISO remains editable`);
    }
    assert.deepEqual(resolveTripDetailTimeEdit(fixtures[0][0], '2026-10-12T10:31'),
      { kind: 'changed', iso: '2026-10-12T01:31:00.000Z' }, `${timezone}: changed minute clears seconds`);
    assert.equal(parseJapanTimeInput('2028-02-29T23:59'), '2028-02-29T14:59:00.000Z');
    assert.equal(parseJapanTimeInput('0099-01-01T09:00'), '0099-01-01T00:00:00.000Z');
    assert.equal(parseJapanTimeInput('0001-01-01T00:00'), '0000-12-31T15:00:00.000Z');
    assert.equal(toJapanTimeInput('0000-12-31T15:00:00.000Z'), '0001-01-01T00:00');
    for (const input of invalidInputs) {
      assert.equal(parseJapanTimeInput(input), null, `${timezone}: invalid edit ${input}`);
      assert.deepEqual(resolveTripDetailTimeEdit(fixtures[0][0], input), { kind: 'invalid' });
    }
    for (const original of invalidTimestamps) {
      assert.equal(toJapanTimeInput(original), '', `${timezone}: invalid stored timestamp ${original}`);
      assert.deepEqual(resolveTripDetailTimeEdit(original, '2026-10-12T10:30'), { kind: 'invalid' });
    }
  }
  assert.equal(localOffsets.size, 3, 'the test actually exercised three different device time zones');
} finally {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
}
console.log('tripDetailTimeInput: Japan-time display, strict parsing, boundaries and lossless unchanged edits passed in three time zones');

// Execute the real screen handlers with synthetic repository callbacks. This
// catches UI-to-helper wiring regressions without importing production services.
const screenSource = ts.createSourceFile('TripDetail.tsx',
  readFileSync(new URL('./TripDetail.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actualHandler(name: string, dependencies: Record<string, unknown>): () => Promise<void> {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(screenSource);
  assert.ok(found, `actual ${name} exists`);
  const compiled = ts.transpileModule(found.getText(screenSource), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}; return ${name};`)(...Object.values(dependencies));
}
const originalTs = '2026-10-12T01:30:45.678Z';
const originalEvents = [
  { id: 'before', ts: '2026-10-12T01:00:00.000Z', type: 'trip_start' },
  { id: 'target', ts: originalTs, type: 'fuel', extras: { liters: 20 } },
  { id: 'after', ts: '2026-10-12T02:00:00.000Z', type: 'trip_end' },
];
function timeScenario(value: string, options: { cancelled?: boolean; consent?: boolean; busy?: boolean; pending?: Promise<void> } = {}) {
  const events = structuredClone(originalEvents);
  const calls = { writes: [] as [string, string][], warnings: [] as string[], alerts: [] as string[], reloads: 0, syncs: 0, closes: 0 };
  const lock = { current: false };
  const handler = actualHandler('handleSaveTime', {
    editing: options.cancelled ? null : { id: 'target', originalTs, value },
    events, saving: options.busy ?? false, inputSaveInFlightRef: lock,
    resolveTripDetailTimeEdit,
    alert: (message: string) => calls.alerts.push(message),
    window: { confirm: (message: string) => { calls.warnings.push(message); return options.consent ?? true; } },
    label: (event: { type: string }) => event.type,
    fmtLocal: toJapanTimeInput,
    setEditing: (edit: unknown) => { if (edit === null) calls.closes++; },
    setSaving: () => {}, setWorkingId: () => {},
    setErr: (error: string) => { throw new Error(error); },
    updateEventTimestamp: async (id: string, iso: string) => {
      calls.writes.push([id, iso]);
      await options.pending;
      events.find(event => event.id === id)!.ts = iso;
    },
    load: async () => { calls.reloads++; },
    requestRouteTrackingSync: () => { calls.syncs++; },
    commitTripDetailOperationalMutation,
  });
  return { handler, calls, events, lock };
}
function fuelScenario(value: string, options: { cancelled?: boolean; composing?: boolean; busy?: boolean; pending?: Promise<void> } = {}) {
  const calls = { writes: [] as [string, number][], alerts: [] as string[], reloads: 0, closes: 0 };
  const handler = actualHandler('handleSaveNumber', {
    numberEditing: options.cancelled ? null : { id: 'target', field: 'liters', value },
    saving: options.busy ?? false, inputSaveInFlightRef: { current: false },
    numberInputComposingRef: { current: options.composing ?? false }, parseFuelInput,
    alert: (message: string) => calls.alerts.push(message),
    setNumberEditing: (edit: unknown) => { if (edit === null) calls.closes++; },
    setSaving: () => {}, setWorkingId: () => {},
    setErr: (error: string) => { throw new Error(error); },
    updateEventOdo: () => { throw new Error('fuel must not update ODO'); },
    updateEventLiters: async (id: string, liters: number) => { calls.writes.push([id, liters]); await options.pending; },
    load: async () => { calls.reloads++; },
  });
  return { handler, calls };
}
async function verifyActualHandlers() {
  const previousTimezone = process.env.TZ;
  try {
    for (const timezone of ['Asia/Tokyo', 'UTC', 'America/Los_Angeles']) {
      process.env.TZ = timezone;
      for (const options of [{}, { cancelled: true }, { busy: true }]) {
        const scenario = timeScenario('2026-10-12T10:30', options);
        await scenario.handler();
        assert.deepEqual(scenario.events, originalEvents, `${timezone}: original records/seconds/ms unchanged`);
        assert.equal(scenario.calls.writes.length, 0);
        assert.equal(scenario.calls.reloads + scenario.calls.syncs + scenario.calls.warnings.length, 0);
      }
      for (const value of ['', '2026-02-30T10:30', '2026-10-12T24:00']) {
        const scenario = timeScenario(value);
        await scenario.handler();
        assert.equal(scenario.calls.writes.length, 0);
        assert.equal(scenario.calls.alerts.length, 1);
        assert.deepEqual(scenario.events, originalEvents);
      }
      for (const value of ['2026-10-12T09:59', '2026-10-12T11:01']) {
        const cancelled = timeScenario(value, { consent: false });
        await cancelled.handler();
        assert.equal(cancelled.calls.warnings.length, 1, 'before/after warning shown');
        assert.equal(cancelled.calls.writes.length, 0, 'declining order warning never saves');
        assert.equal(cancelled.calls.closes, 0, 'warning cancellation leaves editor open');
        assert.equal(cancelled.calls.reloads + cancelled.calls.syncs, 0);
        assert.deepEqual(cancelled.events, originalEvents);
      }
      const changed = timeScenario('2026-10-12T10:31');
      await changed.handler();
      assert.deepEqual(changed.calls.writes, [['target', '2026-10-12T01:31:00.000Z']]);
      assert.equal(changed.calls.reloads, 1);
      assert.equal(changed.calls.syncs, 1);
      assert.equal(changed.calls.closes, 1);
      assert.deepEqual(changed.events[0], originalEvents[0]);
      assert.deepEqual(changed.events[2], originalEvents[2]);
      const consented = timeScenario('2026-10-12T11:01', { consent: true });
      await consented.handler();
      assert.equal(consented.calls.warnings.length, 1);
      assert.deepEqual(consented.calls.writes, [['target', '2026-10-12T02:01:00.000Z']]);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const twice = timeScenario('2026-10-12T10:31', { pending });
  const first = twice.handler();
  await twice.handler();
  assert.equal(twice.calls.writes.length, 1, 'same-render double save only writes once');
  release(); await first;
  assert.equal(twice.lock.current, false);
  for (const value of ['25.5', '２５．５', '２5.５', '.5', '25.']) {
    const scenario = fuelScenario(value);
    await scenario.handler();
    assert.deepEqual(scenario.calls.writes, [['target', value === '.5' ? 0.5 : value === '25.' ? 25 : 25.5]]);
    assert.equal(scenario.calls.reloads, 1);
  }
  for (const value of ['', '0', '.', '-25', '1.2.3', '1,2', '1e3', '25L']) {
    const scenario = fuelScenario(value);
    await scenario.handler();
    assert.equal(scenario.calls.writes.length, 0, `invalid fuel edit ${value} never saves`);
    assert.equal(scenario.calls.alerts.length, 1);
    assert.equal(scenario.calls.reloads, 0);
  }
  for (const options of [{ cancelled: true }, { composing: true }, { busy: true }]) {
    const scenario = fuelScenario('２５．５', options);
    await scenario.handler();
    assert.equal(scenario.calls.writes.length, 0);
  }
  let releaseFuel!: () => void;
  const fuelPending = new Promise<void>(resolve => { releaseFuel = resolve; });
  const fuelTwice = fuelScenario('２５．５', { pending: fuelPending });
  const fuelFirst = fuelTwice.handler();
  await fuelTwice.handler();
  assert.equal(fuelTwice.calls.writes.length, 1, 'fuel edit double save only writes once');
  releaseFuel(); await fuelFirst;
  console.log('TripDetail actual handlers: unchanged/cancel/invalid/busy save zero, order-warning cancellation, one changed save, normalized fuel and duplicate guards passed');
}
void verifyActualHandlers().catch(error => { console.error(error); process.exitCode = 1; });
