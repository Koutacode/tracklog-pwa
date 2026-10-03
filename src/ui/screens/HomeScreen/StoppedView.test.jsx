import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import StoppedView from './StoppedView';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function run() {
  const calls = [];
  const base = {
    disabled: false,
    loadActive: false, unloadActive: false, breakActive: false,
    restActive: false, ferryActive: false, workActive: false,
    canStartLoad: true, canStartUnload: true, canStartBreak: true,
    canStartRest: true, canStartFerry: true, canStartWork: true,
    onOdoDialog: kind => calls.push(['odo', kind]),
    onToggle: (kind, action) => calls.push([kind, action]),
    onRestEnd: () => calls.push(['rest', 'end']),
    onFerry: action => calls.push(['ferry', action]),
    onRefuel: () => calls.push(['refuel']),
    onVoiceCommand: () => calls.push(['voice']),
    voiceAvailable: true, voiceListening: false,
    voiceLastText: null, voiceResult: null, voiceError: null,
  };
  let renderer;
  const update = async overrides => act(async () => {
    renderer.update(<StoppedView {...base} {...overrides} />);
  });
  const text = node => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
  const button = label => renderer.root.findAllByType('button').find(node => text(node).replace(/^[🎙⛽⛴🔧]+/u, '') === label);
  const click = async label => {
    const target = button(label);
    assert.ok(target, `button ${label} is present`);
    assert.equal(target.props.disabled, false, `${label} is enabled`);
    await act(async () => target.props.onClick());
  };
  await act(async () => { renderer = create(<StoppedView {...base} />); });
  assert.equal(renderer.root.findByType('details').props.open, false);
  for (const label of ['積込開始', '荷卸開始', '休憩開始', '休息開始', 'その他', 'フェリー乗船', '給油', '音声操作']) {
    await click(label);
  }
  assert.deepEqual(calls, [
    ['load', 'start'], ['unload', 'start'], ['break', 'start'], ['odo', 'rest_start'],
    ['work', 'start'], ['ferry', 'boarding'], ['refuel'], ['voice'],
  ]);
  calls.length = 0;
  // Start permissions must not hide or disable an already active operation's end.
  await update({
    loadActive: true, unloadActive: true, breakActive: true, restActive: true,
    workActive: true, ferryActive: true,
    canStartLoad: false, canStartUnload: false, canStartBreak: false,
    canStartRest: false, canStartWork: false, canStartFerry: false,
  });
  assert.equal(renderer.root.findByType('details').props.open, true);
  assert.match(text(renderer.root.findByType('summary')), /その他作業中.*フェリー乗船中/);
  for (const label of ['積込終了', '荷卸終了', '休憩終了', '休息終了', 'その他終了', 'フェリー下船']) await click(label);
  assert.deepEqual(calls, [
    ['load', 'end'], ['unload', 'end'], ['break', 'end'], ['rest', 'end'],
    ['work', 'end'], ['ferry', 'disembark'],
  ]);
  // Collapsing remains the user's choice while the same operation continues.
  await act(async () => renderer.root.findByType('details').props.onToggle({ currentTarget: { open: false } }));
  await update({ workActive: true, ferryActive: true, voiceResult: '合成テスト' });
  assert.equal(renderer.root.findByType('details').props.open, false);
  assert.match(text(renderer.root.findByType('summary')), /その他作業中.*フェリー乗船中/);
  await update({ workActive: true });
  assert.equal(renderer.root.findByType('details').props.open, false, 'ending another operation does not force expansion');
  await update({ workActive: true, ferryActive: true });
  assert.equal(renderer.root.findByType('details').props.open, true, 'a newly started secondary operation reveals its end action');
  await update({ disabled: true, workActive: true, ferryActive: true });
  assert.ok(renderer.root.findAllByType('button').every(node => node.props.disabled), 'global operation lock disables every action');
  await update({ canStartLoad: false, canStartUnload: false, canStartBreak: false, canStartRest: false, canStartWork: false, canStartFerry: false });
  for (const label of ['積込開始', '荷卸開始', '休憩開始', '休息開始', 'その他', 'フェリー乗船']) assert.equal(button(label).props.disabled, true);
  assert.doesNotMatch(text(renderer.root.findByType('summary')), /作業中|乗船中/);
  await update({ voiceAvailable: false });
  assert.equal(button('音声利用不可').props.disabled, true);
  await update({ voiceListening: true });
  assert.equal(button('聞き取り中…').props.disabled, true);
  calls.length = 0;
  const endTrip = renderer.root.findAllByType('button').find(node => text(node).startsWith('運行を終了'));
  await act(async () => endTrip.props.onClick());
  assert.deepEqual(calls, [['odo', 'trip_end']], 'trip end still opens ODO confirmation only');
  await act(async () => renderer.unmount());
  await act(async () => { renderer = create(<StoppedView {...base} workActive />); });
  assert.equal(renderer.root.findByType('details').props.open, true, 'restored active work is visible on initial render');
  await act(async () => renderer.unmount());
  console.log('StoppedView: action routing, locks, active end actions and disclosure state passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
