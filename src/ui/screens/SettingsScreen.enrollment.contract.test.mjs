import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./SettingsScreen.tsx', import.meta.url), 'utf8');

assert.match(
  source,
  /approvalStatus === 'approved'[\s\S]*?'承認済み'[\s\S]*?approvalStatus === 'rejected'[\s\S]*?'拒否済み'[\s\S]*?approvalStatus === 'pending'[\s\S]*?'管理者承認待ち'[\s\S]*?'承認申請が必要'/,
  'approved, rejected, pending, and authenticated-unregistered states have distinct labels',
);

assert.match(
  source,
  /\{!authInitialized && \([\s\S]*?認証メールを送信[\s\S]*?\)\}/,
  'email login is offered only when the driver is genuinely unauthenticated',
);

assert.match(
  source,
  /\{authInitialized && approvalStatus === 'unregistered' && \([\s\S]*?await setDriverProfileLocal\(validation\.value\);[\s\S]*?await hydrateRemoteSyncState\(\);[\s\S]*?const identity = await getDriverIdentity\(\);[\s\S]*?承認申請を再送[\s\S]*?\)\}/,
  'authenticated unregistered drivers can resend enrollment with the current session and refresh identity/sync',
);

assert.match(
  source,
  /approvalStatus === 'pending'[\s\S]*?認証と承認申請は完了しています。管理者が許可するまでお待ちください。/,
  'pending explicitly means authentication and enrollment are complete',
);

assert.match(
  source,
  /getDriverAuthWorkflowErrorCode\(error\)[\s\S]*?driver_auth_session_refresh_failed[\s\S]*?driver_auth_email_mismatch[\s\S]*?driver_native_credentials_update_failed[\s\S]*?driver_profile_enrollment_failed/,
  'workflow failures keep actionable, state-specific messages',
);

assert.match(
  source,
  /usesDriverAdminAccount && canOpenAdmin && <Link to="\/admin"/,
  'native admin visibility remains gated by the authenticated admin check',
);

console.log('SettingsScreen enrollment contract: 6 tests passed');
