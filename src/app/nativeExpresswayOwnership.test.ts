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

console.log('nativeExpresswayOwnership: 4 tests passed');
