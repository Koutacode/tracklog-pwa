import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const supervisorSource = readFileSync(
  new URL('./RouteTrackingSupervisor.tsx', import.meta.url),
  'utf8',
);
const promptSource = readFileSync(
  new URL('../services/nativeExpresswayPrompt.ts', import.meta.url),
  'utf8',
);

assert.doesNotMatch(
  supervisorSource,
  /enqueueNativeExpresswayRoutePointDetection/,
  'new Android route points must never enter the legacy TS detector',
);
assert.match(
  supervisorSource,
  /drainNativeResidentExpresswayEventQueue/,
  'Supervisor must materialize Java-owned transitions',
);
assert.ok(
  supervisorSource.lastIndexOf('drainNativeResidentExpresswayEventQueue')
    < supervisorSource.lastIndexOf('persistNativeResidentLocationQueue()'),
  'Java transitions must be drained before the route-point spool',
);
assert.match(
  promptSource,
  /owner === RESIDENT_SERVICE_NOTIFICATION_OWNER\) return/,
  'TS notification listener must ignore Java-owned actions',
);

assert.doesNotMatch(
  supervisorSource,
  /requestLocationHeartbeatNow|navigator\.geolocation\.getCurrentPosition/,
  'normal supervisor ticks and resume must not acquire a second WebView location',
);
assert.match(
  supervisorSource,
  /if \(native\) \{\s*(?:\/\/[^\n]*\n\s*)*stopLocationHeartbeat\(\)/,
  'Android automatic location sharing must stay with the native owner',
);
assert.match(
  supervisorSource,
  /if \(!native\) startLocationHeartbeat\(\)/,
  'PWA keeps its existing shared watcher heartbeat',
);
const adminMessagesSource = readFileSync(
  new URL('../services/adminMessages.ts', import.meta.url), 'utf8',
);
assert.match(
  adminMessagesSource,
  /await requestLocationHeartbeatNow\(\)/,
  'explicit administrator current-location requests retain their one-shot acquisition',
);

console.log('nativeExpresswayOwnership: 8 tests passed');
