import type { RemoteDeviceProfile } from '../../domain/remoteTypes';

export type AdminDeviceSeenStatus = {
  kind: 'active' | 'recent' | 'stale';
  label: '稼働中' | '最近同期' | '要確認';
};

export type AdminDeviceStatusFilter = 'all' | AdminDeviceSeenStatus['kind'] | 'pending';

export type AdminDeviceFilterOptions = {
  query: string;
  status: AdminDeviceStatusFilter;
  nowMs?: number;
};

const SEARCH_SEPARATOR_PATTERN = /[\s\-‐‑‒–—―−()（）]+/g;

function normalizeSearchValue(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function compactSearchValue(value: string) {
  return normalizeSearchValue(value).replace(SEARCH_SEPARATOR_PATTERN, '');
}

export function getAdminDeviceSeenStatus(
  lastSeenAt?: string | null,
  nowMs = Date.now(),
): AdminDeviceSeenStatus {
  if (!lastSeenAt) return { kind: 'stale', label: '要確認' };
  const seenAt = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seenAt)) return { kind: 'stale', label: '要確認' };
  const elapsedMinutes = Math.max(0, nowMs - seenAt) / 60000;
  if (elapsedMinutes <= 15) return { kind: 'active', label: '稼働中' };
  if (elapsedMinutes <= 120) return { kind: 'recent', label: '最近同期' };
  return { kind: 'stale', label: '要確認' };
}

export function getAdminDeviceApprovalStatus(profile: RemoteDeviceProfile) {
  if (profile.approval_status === 'approved' || profile.approval_status === 'rejected') {
    return profile.approval_status;
  }
  return 'pending' as const;
}

function matchesDeviceQuery(profile: RemoteDeviceProfile, query: string) {
  const normalizedQuery = normalizeSearchValue(query).trim();
  if (!normalizedQuery) return true;

  const fields = [
    profile.display_name,
    profile.vehicle_label,
    profile.driver_email,
    profile.driver_phone,
    profile.device_id,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const searchable = fields.map(normalizeSearchValue).join('\n');
  const compactSearchable = fields.map(compactSearchValue).join('\n');
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  return tokens.every(token => {
    const compactToken = compactSearchValue(token);
    return searchable.includes(token) || (compactToken.length > 0 && compactSearchable.includes(compactToken));
  });
}

export function filterAdminDevices(
  devices: readonly RemoteDeviceProfile[],
  options: AdminDeviceFilterOptions,
) {
  const nowMs = options.nowMs ?? Date.now();
  return devices.filter(device => {
    if (!matchesDeviceQuery(device, options.query)) return false;
    if (options.status === 'all') return true;
    if (options.status === 'pending') return getAdminDeviceApprovalStatus(device) === 'pending';
    return getAdminDeviceSeenStatus(device.last_seen_at, nowMs).kind === options.status;
  });
}
