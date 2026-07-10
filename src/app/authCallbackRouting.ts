import type { DriverIdentity } from '../domain/remoteTypes';

export type WebAuthCallbackRole = 'driver' | 'admin';

export const WEB_AUTH_CALLBACK_PATHS: Record<WebAuthCallbackRole, string> = {
  driver: '/auth/driver/callback',
  admin: '/auth/admin/callback',
};

export function getWebAuthCallbackRole(pathname: string): WebAuthCallbackRole | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  if (normalized === WEB_AUTH_CALLBACK_PATHS.driver) return 'driver';
  if (normalized === WEB_AUTH_CALLBACK_PATHS.admin) return 'admin';
  return null;
}

export function getDriverPostAuthPath(identity: DriverIdentity) {
  const canUseHome =
    identity.configured &&
    identity.authInitialized &&
    identity.profileComplete &&
    identity.approvalStatus === 'approved';
  return canUseHome ? '/' : '/settings';
}
