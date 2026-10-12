import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import FuelDialog from './FuelDialog';
import OdoDialog from './OdoDialog';
import { parseFuelInput } from './fuelInput';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.document = { activeElement: null };
globalThis.HTMLElement = class {};
globalThis.window = { setTimeout: () => 1, clearTimeout: () => {} };

async function main() {
  for (const [raw, liters] of [
    ['25.5', 25.5], ['２５．５', 25.5], ['２5.５', 25.5], ['２5．５', 25.5],
    ['.5', 0.5], ['．５', 0.5], ['25.', 25], ['２５．', 25], ['001.5', 1.5],
  ]) {
    assert.deepEqual(parseFuelInput(raw), { ok: true, liters }, `fuel parser accepts ${raw} without changing its amount`);
  }
  for (const raw of [
    '', '0', '０．０', '.', '．', '1.2.3', '１．２．３', '-25', '－２５', '−25',
    '1,5', '１，５', '1,000', '1e3', '+25', '25L', '２５リットル', '25 5', ' 25 ', '25\n', '25\r', 'Infinity',
    '9'.repeat(400),
  ]) {
    const parsed = parseFuelInput(raw);
    assert.equal(parsed.ok, false, `fuel parser rejects the whole input ${raw}`);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length > 0, 'rejected fuel includes a Japanese correction message');
  }
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

  const safeRecords = [];
  const safeProps = { open: true, onConfirm: value => safeRecords.push(value), onCancel() {} };
  await act(async () => { renderer = create(<FuelDialog {...safeProps} />); });
  const input = () => renderer.root.findByType('input');
  const reopen = async () => {
    await act(async () => renderer.update(<FuelDialog {...safeProps} open={false} />));
    await act(async () => renderer.update(<FuelDialog {...safeProps} />));
  };
  for (const raw of ['-25', '－２５', '1,5', '１，５', '1e3', '25L', '1.2.3', '25 5']) {
    await act(async () => input().props.onChange({ target: { value: raw } }));
    assert.equal(input().props.value, raw, 'invalid input remains visible instead of losing characters');
    assert.equal(input().props['aria-invalid'], true);
    const error = renderer.root.findByProps({ role: 'alert' });
    assert.ok(input().props['aria-describedby'].split(' ').includes(error.props.id));
    assert.equal(error.children.join(''), parseFuelInput(raw).error);
    assert.equal(record().props.disabled, true);
    await act(async () => record().props.onClick());
    assert.deepEqual(safeRecords, [], 'invalid fuel never invokes the save callback');
  }
  await act(async () => input().props.onChange({ target: { value: '２５．５' } }));
  assert.equal(input().props.value, '２５．５', 'valid full-width input also remains visible as entered');
  assert.equal(input().props['aria-invalid'], false);
  assert.equal(renderer.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(record().props.disabled, false);
  await act(async () => {
    const click = record().props.onClick;
    click();
    click();
  });
  assert.deepEqual(safeRecords, [25.5], 'two confirmations before rerender save only once');
  assert.equal(record().props.disabled, true);
  await act(async () => record().props.onClick());
  assert.deepEqual(safeRecords, [25.5], 'a confirmed dialog stays locked until reopened');

  await reopen();
  assert.equal(input().props.value, '');
  assert.equal(record().props.disabled, true);
  await act(async () => input().props.onChange({ target: { value: '25' } }));
  const beforeComposition = safeRecords.length;
  await act(async () => {
    input().props.onCompositionStart();
    input().props.onChange({ target: { value: '２５．' } });
    record().props.onClick();
  });
  assert.equal(record().props.disabled, true, 'IME composition disables confirmation');
  assert.equal(input().props.value, '２５．');
  assert.equal(safeRecords.length, beforeComposition, 'composition blocks confirmation before state rerenders');
  await act(async () => record().props.onClick());
  assert.equal(safeRecords.length, beforeComposition);
  await act(async () => input().props.onCompositionEnd({ currentTarget: { value: '２５．７' } }));
  assert.equal(input().props.value, '２５．７');
  assert.equal(record().props.disabled, false);
  await act(async () => record().props.onClick());
  assert.deepEqual(safeRecords, [25.5, 25.7], 'only the committed composition value is saved');

  for (const [raw, expected] of [['.5', 0.5], ['25.', 25]]) {
    await reopen();
    await act(async () => input().props.onChange({ target: { value: raw } }));
    assert.equal(record().props.disabled, false);
    await act(async () => record().props.onClick());
    assert.equal(safeRecords.at(-1), expected, 'reopening resets the confirmation lock');
  }
  await reopen();
  await act(async () => input().props.onCompositionStart());
  await act(async () => input().props.onCompositionEnd({ currentTarget: { value: '１，５' } }));
  assert.equal(input().props.value, '１，５');
  assert.equal(record().props.disabled, true, 'invalid committed IME input remains rejected');
  const beforeInvalidComposition = safeRecords.length;
  await act(async () => record().props.onClick());
  assert.equal(safeRecords.length, beforeInvalidComposition);
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
  console.log('InputDialogs: strict fuel, full-width/raw input, composition, single confirmation, cancel/Escape, reopen, zero ODO and busy contracts passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
