import assert from 'node:assert/strict';
import { clearLegacyExpresswayNotifications, showNativeExpresswayEndPrompt } from './nativeExpresswayPrompt';

async function run() {
  const canceled: number[][] = [];
  const port = {
    getPending: async () => ({ notifications: [
      { id: 610001, title: 'old confirmation', body: '', extra: { kind: 'expressway_end_prompt_v1' } },
      { id: 740000, title: 'admin', body: '', extra: { kind: 'admin_message' } },
    ] }),
    getDeliveredNotifications: async () => ({ notifications: [
      { id: 610002, title: 'TrackLog: 高速道路終了確認', body: '' },
      { id: 610003, title: 'unrelated', body: '' },
      { id: 610004, title: 'TrackLog: 高速道路終了確認', body: '', tag: 'other' },
      { id: 41139, title: 'TrackLog: 高速道路終了確認', body: '' },
      { id: 740001, title: '管理者メッセージ', body: '' },
    ] }),
    cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
      canceled.push(notifications.map(notification => notification.id));
    },
  };
  await clearLegacyExpresswayNotifications(port);
  assert.deepEqual(canceled, [[41140], [610001, 610002]], 'only old expressway notifications are cancelled');
  assert.equal(await showNativeExpresswayEndPrompt({
    tripId: 'synthetic-trip', detectedAt: '2026-11-04T00:00:00.000Z', speedKmh: 10,
    geo: { lat: 1, lng: 2 },
  }), false, 'detection does not post a system notification');
  let retry = 0;
  const flaky = { ...port, getPending: async () => {
    retry += 1;
    if (retry === 1) throw new Error('temporary notification listing failure');
    return { notifications: [] };
  } };
  await assert.rejects(clearLegacyExpresswayNotifications(flaky));
  assert.deepEqual(canceled[canceled.length - 1], [41140], 'native legacy notification is retired even when listing fails');
  await clearLegacyExpresswayNotifications(flaky);
  assert.equal(retry, 2, 'cleanup errors remain retryable');
  console.log('nativeExpresswayPromptCleanup: selective cleanup and no-post assertions passed');
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
