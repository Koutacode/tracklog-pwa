import { withDriverAuthStorageMutation } from './driverAuthInteraction';
import { hasDriverCandidateAttempt } from './driverCandidateAuth';
import { AuthError, AuthRetryableFetchError } from '@supabase/supabase-js';
import type { AuthStorageAdapter } from './supabase';
import type { TrackLogDB } from '../db/db';
import { DRIVER_AUTH_STORAGE_KEY } from './authStorageKeys';

export const DRIVER_OWNER_KEY = `${DRIVER_AUTH_STORAGE_KEY}-owner-id`;
const conflict = () => new AuthError('既存データと異なるアカウントです。元のアカウントでログインしてください。データの削除は不要です。', 409, 'driver_account_conflict');
const recoveryPending = () => new AuthError('既存の端末認証を確認できません。データを保持して復旧を待っています。', 503, 'driver_owner_recovery_pending');
export function savedSessionOwner(raw: string | null): string | null {
  try { const value = JSON.parse(raw ?? 'null'); const id = (value?.currentSession ?? value)?.user?.id; return typeof id === 'string' && id ? id : null; } catch { return null; }
}
export async function readDriverOwnership(db: TrackLogDB) {
  const owners = new Set<string>();
  let registered = (await db.meta.get('remote_auth_initialized'))?.value === 'true';
  for (const table of [db.events, db.routePoints, db.reportTrips, db.deletedEventTombstones, db.deletedTripTombstones, db.deletedReportTombstones]) {
    await table.toCollection().each(row => { registered = true; if (row.ownerUserId) owners.add(row.ownerUserId); });
  }
  return { owners: [...owners], registered };
}
/** Only a credential already installed in native can supply the legacy ID. */
export async function verifyInstalledNativeOwner(options: {
  read: () => Promise<{ configured: boolean; blocked?: boolean; accessToken?: string; refreshToken?: string }>;
  verify: (token: string) => Promise<{ id: string; is_anonymous?: boolean } | null>;
}): Promise<string | null> {
  try {
    const first = await options.read();
    if (first.configured === false && first.blocked === false && first.accessToken === '' && first.refreshToken === '') return null;
    if (!first.configured || first.blocked !== false || !first.accessToken) throw recoveryPending();
    const user = await options.verify(first.accessToken);
    const second = await options.read();
    if (!user?.id || user.is_anonymous || !second.configured || second.blocked !== false || second.accessToken !== first.accessToken || second.refreshToken !== first.refreshToken) throw recoveryPending();
    return user.id;
  } catch { throw recoveryPending(); }
}
/** Data-preservation constraint before SDK persistence and SIGNED_IN. Not RLS. */
export function createDriverAccountStorage(storage: AuthStorageAdapter,
  readOwnership: () => Promise<{ owners: string[]; registered: boolean }>,
  readNativeOwner?: () => Promise<string | null>) {
  let expected: string | null = null;
  let tail = Promise.resolve();
  const assertOwner = async (id: string, verifyAllOwners = true) => {
    if (!id || (expected && expected !== id)) throw conflict();
    const pin = await storage.getItem(DRIVER_OWNER_KEY);
    const previous = savedSessionOwner(await storage.getItem(DRIVER_AUTH_STORAGE_KEY));
    const local = pin && !verifyAllOwners ? { owners: [], registered: false } : await readOwnership();
    const owners = new Set([...local.owners, pin, previous].filter((v): v is string => !!v));
    if ((!pin || verifyAllOwners) && readNativeOwner) { const native = await readNativeOwner(); if (native) owners.add(native); }
    if ([...owners].some(owner => owner !== id) || (local.registered && !owners.size)) throw conflict();
  };
  return {
    assertOwner,
    async withExpectedOwner<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (expected) throw conflict();
      expected = id;
      try { return await fn(); } finally { expected = null; }
    },
    getItem: (key: string) => storage.getItem(key),
    removeItem: (key: string) => storage.removeItem(key),
    setItem(key: string, value: string) {
      if (key !== DRIVER_AUTH_STORAGE_KEY) return storage.setItem(key, value);
      const run = tail.then(() => withDriverAuthStorageMutation(async () => {
        const id = savedSessionOwner(value); if (!id) throw conflict();
        // Normal refresh keeps the existing pin-based path; explicit candidate
        // confirmation checks DB and native ownership independently.
        await assertOwner(id, false);
        const previous = savedSessionOwner(await storage.getItem(DRIVER_AUTH_STORAGE_KEY));
        // Preserve normal rotation for the already-installed same owner. A new
        // login cannot overlap candidate start (the shared interaction lock).
        if (!expected && hasDriverCandidateAttempt() && previous !== id) {
          throw new AuthRetryableFetchError('仮ログインの確認中です。既存認証は保持しています。', 503);
        }
        // Session write failure may retain a restrictive pin. Never clear it
        // on logout/cancel; a same-owner retry is the recovery path.
        if (expected || !hasDriverCandidateAttempt()) await storage.setItem(DRIVER_OWNER_KEY, id);
        await storage.setItem(key, value);
      }));
      const safe = run.catch(error => {
        if (error instanceof AuthRetryableFetchError) throw error;
        // auth-js refresh must neither delete the old session nor reject an
        // unobserved Deferred with a plain storage Error.
        throw new AuthRetryableFetchError('認証を保存できませんでした。既存データを保持して再試行してください。', 503);
      });
      tail = safe.catch(() => undefined);
      return safe;
    },
  };
}
