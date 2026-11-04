import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const java = readFileSync('android/app/src/main/java/com/tracklog/assist/ResidentExpresswayNotification.java', 'utf8');
const service = readFileSync('android/app/src/main/java/com/tracklog/assist/ResidentLocationService.java', 'utf8');
const plugin = readFileSync('android/app/src/main/java/com/tracklog/assist/ResidentLocationPlugin.java', 'utf8');

assert.match(java, /static final int NOTIFICATION_ID\s*=\s*41140\s*;/);
assert.match(java, /static void show\([^)]*\)\s*\{[^}]*cancel\(context\)/s);
assert.doesNotMatch(java, /\.notify\s*\(/, 'the expressway confirmation never posts a native notification');
assert.match(java, /restoreIfPending\([^)]*\)\s*\{[^}]*freshPromptIdForNotification/s,
  'restoring still runs durable stale-prompt retirement');
assert.match(service, /static final int NOTIFICATION_ID\s*=\s*41139\s*;/);
assert.match(service, /ServiceCompat\.startForeground\(this, NOTIFICATION_ID, buildNotification\(\)/,
  'the position-recording foreground notification remains enabled');
assert.match(service, /tryCommitUnavailableEndPrompt\(/);
assert.match(service, /commitEndPrompt\(/);
assert.match(plugin, /ResidentExpresswayStore\.reconcile\(/);
console.log('expressway-popup-only: native no-post, prompt freshness, foreground recording and detection contracts passed');
