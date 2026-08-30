import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const hookSource = await readFile(new URL('./useAdminEntryAvailability.ts', import.meta.url), 'utf8');
const homeSource = await readFile(new URL('../ui/screens/HomeScreen.tsx', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../ui/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
const remoteAuthSource = await readFile(new URL('../services/remoteAuth.ts', import.meta.url), 'utf8');
const privilegedApiSource = await readFile(new URL('../services/tracklogPrivilegedApi.ts', import.meta.url), 'utf8');

assert.match(
  hookSource,
  /getAdminSession\(\)[\s\S]*?reduceAdminEntryAvailability[\s\S]*?classifyAdminValidationFailure/,
  'admin entry visibility is driven by validated sessions and the shared failure policy',
);
assert.match(hookSource, /window\.addEventListener\('online', onOnline\)/, 'online recovery revalidates');
assert.match(
  hookSource,
  /window\.setInterval\(\(\) => void refresh\(\), ADMIN_ENTRY_REVALIDATE_MS\)/,
  'backend recovery revalidates even when the browser emits no online event',
);
assert.match(
  hookSource,
  /document\.addEventListener\('visibilitychange', onVisible\)/,
  'foreground browser visibility revalidates',
);
assert.match(
  hookSource,
  /CapacitorApp\.addListener\('appStateChange'[\s\S]*?CapacitorApp\.addListener\('resume'/,
  'native foreground and resume events revalidate',
);
assert.match(homeSource, /const canOpenAdmin = useAdminEntryAvailability\(\)/, 'Home uses shared admin entry policy');
assert.match(
  settingsSource,
  /const canOpenAdmin = useAdminEntryAvailability\(\{ enabled: usesDriverAdminAccount \}\)/,
  'Android Settings uses shared admin entry policy',
);
assert.match(
  remoteAuthSource,
  /driverAuthSupabase\.auth\.getUser\(accessToken\)/,
  'Android validates the native token with an auth-capable client',
);
assert.doesNotMatch(
  remoteAuthSource,
  /adminAccessSupabase\.auth\.getUser\(accessToken\)/,
  'Android never calls auth APIs on the accessToken-backed data client',
);
assert.match(
  remoteAuthSource,
  /getTracklogAdminAccessStateViaFunction\([\s\S]*?accessToken: validatedNativeAccessToken/,
  'Android reuses the validated native token for the server allowlist check',
);
assert.match(
  privilegedApiSource,
  /accessToken \? driverAuthSupabase : adminAccessSupabase[\s\S]*?getAdminAccessState[\s\S]*?accessToken/,
  'the privileged admin check sends an explicit native Authorization token',
);

console.log('Admin entry availability contract: 11 tests passed');
