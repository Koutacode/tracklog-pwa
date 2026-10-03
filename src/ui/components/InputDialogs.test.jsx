import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import FuelDialog from './FuelDialog';
import OdoDialog from './OdoDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.document = { activeElement: null };
globalThis.HTMLElement = class {};
globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} };

async function main() {
  let renderer;
  const records = [];
  let cancellations = 0;
  const props = { open: true, onConfirm: value => records.push(value), onCancel: () => cancellations++ };
  await act(async () => { renderer = create(<FuelDialog {...props} />); });
  const record = () => renderer.root.findAllByType('button').find(button => button.children.includes('記録'));
  for (const value of ['', '0', '.', '1.2.3']) {
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value } }));
    assert.equal(record().props.disabled, true, `invalid fuel ${value} cannot be recorded`);
    await act(async () => record().props.onClick());
    assert.equal(records.length, 0);
  }
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: '25.5' } }));
  assert.equal(record().props.disabled, false);
  await act(async () => renderer.root.findAllByType('button')[0].props.onClick());
  assert.equal(cancellations, 1);
  assert.deepEqual(records, [], 'cancel does not record fuel');
  await act(async () => record().props.onClick());
  assert.deepEqual(records, [25.5]);
  await act(async () => renderer.update(<FuelDialog {...props} open={false} />));
  await act(async () => renderer.update(<FuelDialog {...props} />));
  assert.equal(renderer.root.findByType('input').props.value, '', 'reopening starts with empty fuel input');
  await act(async () => renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
  assert.equal(cancellations, 2);
  await act(async () => renderer.unmount());

  const odoProps = { ...props, title: '合成ODO', allowZero: true };
  await act(async () => { renderer = create(<OdoDialog {...odoProps} />); });
  const confirm = () => renderer.root.findByProps({ type: 'submit' });
  assert.equal(confirm().props.disabled, true);
  await act(async () => renderer.root.findByProps({ 'aria-label': '0を入力' }).props.onClick());
  assert.equal(confirm().props.disabled, false, 'existing rest-without-distance zero contract remains');
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(records, [25.5, 0]);
  await act(async () => renderer.update(<OdoDialog {...odoProps} busy />));
  assert.equal(confirm().props.disabled, true);
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(records, [25.5, 0], 'busy confirmation cannot repeat a save');
  await act(async () => renderer.unmount());
  console.log('InputDialogs: invalid fuel, decimal, cancel/Escape, reopen, zero ODO and busy contracts passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
