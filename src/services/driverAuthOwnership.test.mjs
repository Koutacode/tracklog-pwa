import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const sourceRoot = join(root, 'src');

function listSourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? listSourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const forbidden = [];
for (const path of listSourceFiles(sourceRoot)) {
  const source = readFileSync(path, 'utf8');
  if (source.includes('driverSupabase.auth')) {
    forbidden.push(relative(root, path));
  }
}
if (forbidden.length > 0) {
  throw new Error(`Android data client must never own Auth refresh: ${forbidden.join(', ')}`);
}

const supabaseSource = readFileSync(join(sourceRoot, 'services', 'supabase.ts'), 'utf8');
if (!supabaseSource.includes('accessToken: getNativeDriverAccessToken')) {
  throw new Error('Android data requests must obtain access tokens from the native owner');
}
if (!supabaseSource.includes('export const driverAuthSupabase')) {
  throw new Error('Driver Auth and Android data clients must remain separate');
}

const resolverSource = readFileSync(join(sourceRoot, 'services', 'icResolver.ts'), 'utf8');
if (!resolverSource.includes('forceRefresh: true')) {
  throw new Error('Android IC resolver 401 retries must force refresh through the native owner');
}

const remoteAuthSource = readFileSync(join(sourceRoot, 'services', 'remoteAuth.ts'), 'utf8');
const otpVerifierStart = remoteAuthSource.indexOf('export async function verifyDriverEmailOtp');
const otpVerifierEnd = remoteAuthSource.indexOf('\nexport async function signOutDriver', otpVerifierStart);
if (otpVerifierStart < 0 || otpVerifierEnd < 0) {
  throw new Error('Driver OTP verification flow must remain inspectable');
}
const otpVerifierSource = remoteAuthSource.slice(otpVerifierStart, otpVerifierEnd);
if (!otpVerifierSource.includes('enrollmentAccessToken: verifiedSession.access_token')) {
  throw new Error('OTP verification must carry its freshly verified access token into enrollment');
}
if (!otpVerifierSource.includes('skipNativeSessionRestore: true')) {
  throw new Error('OTP enrollment must not replace the freshly verified session with native persistence');
}

const privilegedSource = readFileSync(join(sourceRoot, 'services', 'tracklogPrivilegedApi.ts'), 'utf8');
const invokeStart = privilegedSource.indexOf('async function invokeTracklogPrivileged');
const invokeEnd = privilegedSource.indexOf('\nexport async function claimTracklogDeviceProfileViaFunction', invokeStart);
if (invokeStart < 0 || invokeEnd < 0) {
  throw new Error('TrackLog privileged invocation helper must remain inspectable');
}
const invokeSource = privilegedSource.slice(invokeStart, invokeEnd);
if (!invokeSource.includes('headers: { Authorization: `Bearer ${enrollmentAccessToken}` }')) {
  throw new Error('Fresh OTP enrollment token must be sent in the Authorization header');
}
const requestBodyStart = invokeSource.indexOf('body: {');
const requestBodyEnd = invokeSource.indexOf('},', requestBodyStart);
if (requestBodyStart < 0 || requestBodyEnd < 0) {
  throw new Error('TrackLog privileged request body must remain inspectable');
}
const requestBodySource = invokeSource.slice(requestBodyStart, requestBodyEnd);
if (requestBodySource.includes('accessToken') || requestBodySource.includes('enrollmentAccessToken')) {
  throw new Error('OTP access tokens must never be serialized into the privileged request body');
}

const claimStart = privilegedSource.indexOf('export async function claimTracklogDeviceProfileViaFunction');
const claimEnd = privilegedSource.indexOf('\nexport async function getTracklogAdminAccessStateViaFunction', claimStart);
if (claimStart < 0 || claimEnd < 0) {
  throw new Error('TrackLog device claim helper must remain inspectable');
}
const claimSource = privilegedSource.slice(claimStart, claimEnd);
if (!claimSource.includes('enrollmentAccessToken ? driverAuthSupabase : driverSupabase')) {
  throw new Error('Only explicit OTP enrollment may bypass the native-owned Android data client');
}
if (!claimSource.includes("'claimDeviceProfile',") || !claimSource.includes('enrollmentAccessToken,')) {
  throw new Error('Device claim must forward the explicit OTP token only to the Authorization-header path');
}

console.log('driverAuthOwnership: 11 checks passed');
