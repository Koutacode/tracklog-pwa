import { withDriverRegistrationMutation } from './driverRegistrationLock';
import { withDriverAuthInteraction, withDriverAuthStorageMutation } from './driverAuthInteraction';
import { AuthError, createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthStorageAdapter } from './supabase';

export const CANDIDATE_RECORD_KEY = 'tracklog-driver-candidate-attempt';
export const candidateSessionKey = (id: string) => `tracklog-driver-candidate-auth:${id}`;
const TTL = 10 * 60_000;
type Identity = { id: string; email: string };
type Attempt = {
  id: string; expiresAt: number; phase: 'choosing' | 'selected' | 'committing';
  redirect: string; callback?: string; owner?: Identity; requiredOwner?: Identity;
  // The SDK can never read this one-way recovery envelope.
  handoff?: Session;
};
const unavailable = () => new Error('仮ログインを確認できません。状態を確認するか選び直してください。');
export function isDriverCandidateCallback(url: string) {
  try { return new URL(url).searchParams.has('candidate'); } catch { return false; }
}

/** Separate client per attempt. No runtime imports of active/native/DB/sync. */
export function createDriverCandidateAuth(options: {
  url: string; apiKey: string; storage: AuthStorageAdapter;
  fetch?: typeof fetch; now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => undefined).then(async () => typeof navigator !== 'undefined' && navigator.locks
      ? await navigator.locks.request(CANDIDATE_RECORD_KEY, fn) : await fn());
    tail = run.catch(() => undefined); return run;
  };
  const read = async (): Promise<Attempt | null> => {
    const raw = await options.storage.getItem(CANDIDATE_RECORD_KEY);
    if (!raw) return null;
    try {
      const a = JSON.parse(raw) as Attempt;
      if (!/^[a-f0-9-]{36}$/.test(a.id) || !Number.isFinite(a.expiresAt) || !['choosing','selected','committing'].includes(a.phase) || typeof a.redirect !== 'string') throw unavailable();
      if (a.phase === 'committing' && (!a.owner?.id || !a.owner.email)) throw unavailable();
      return a;
    } catch { throw unavailable(); }
  };
  const current = async (id?: string) => {
    const a = await read();
    if (!a || (id && a.id !== id) || (a.phase !== 'committing' && a.expiresAt <= now())) throw unavailable();
    return a;
  };
  const write = (a: Attempt) => options.storage.setItem(CANDIDATE_RECORD_KEY, JSON.stringify(a));
  const keys = (id: string) => [candidateSessionKey(id), `${candidateSessionKey(id)}-code-verifier`, `${candidateSessionKey(id)}-user`];
  const clearKeys = async (id: string) => { for (const key of keys(id)) await options.storage.removeItem(key); };
  let cached: { id: string; ready: Promise<SupabaseClient> } | null = null;
  const clientFor = (a: Attempt): Promise<SupabaseClient> => {
    if (a.phase === 'committing') throw unavailable();
    if (cached?.id === a.id) return cached.ready;
    const namespace = keys(a.id);
    const isWritable = (other: Attempt | null) => other?.id === a.id && other.phase !== 'committing' && other.expiresAt > now();
    const client = createClient(options.url, options.apiKey, {
      auth: { storageKey: namespace[0], flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
        storage: {
          getItem: async key => {
            if (!namespace.includes(key)) throw unavailable();
            return isWritable(await read()) ? options.storage.getItem(key) : null;
          },
          setItem: async (key, value) => {
            if (!namespace.includes(key)) throw unavailable();
            try {
              // Retired responses must not throw a plain Error into auth-js's
              // refresh Deferred, nor be saved under any newer attempt's key.
              if (!isWritable(await read())) return;
              await options.storage.setItem(key, value);
              if (!isWritable(await read())) await options.storage.removeItem(key);
            } catch { throw new AuthError('仮ログインを保存できません。', 503, 'candidate_storage_unavailable'); }
          },
          removeItem: async key => { if (!namespace.includes(key)) throw unavailable(); await options.storage.removeItem(key); },
        },
      },
      ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
    });
    const ready = client.auth.initialize().then(async () => { await client.auth.stopAutoRefresh(); return client; });
    cached = { id: a.id, ready }; return ready;
  };
  const verifiedSession = async (a: Attempt) => {
    const client = await clientFor(a);
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw unavailable();
    const result = await client.auth.getUser(data.session.access_token);
    const user = result.data.user;
    const expected = a.owner?.id ?? a.requiredOwner?.id;
    if (result.error || !user?.id || !user.email || user.is_anonymous || user.id !== data.session.user.id || (expected && expected !== user.id)) throw unavailable();
    await current(a.id);
    return { ...data.session, user };
  };
  const parse = async (url: string) => {
    const parsed = new URL(url), a = await current(parsed.searchParams.get('candidate') ?? 'invalid');
    const redirect = new URL(a.redirect);
    if (parsed.protocol !== redirect.protocol || parsed.host !== redirect.host || parsed.pathname !== redirect.pathname || parsed.hash || parsed.searchParams.has('access_token') || parsed.searchParams.has('refresh_token')) throw unavailable();
    return { parsed, a };
  };
  return {
    start: (native: boolean, origin: string, restart = false, expectedAttemptId?: string) => serial(() => withDriverAuthInteraction(() => withDriverRegistrationMutation(async () => {
      const old = await read();
      if (expectedAttemptId !== undefined && old?.id !== expectedAttemptId) throw unavailable();
      if (old && (old.phase === 'committing' || old.expiresAt > now()) && !restart) throw new Error('選択中のログインがあります。取消または再試行してください。');
      const id = crypto.randomUUID();
      const redirect = new URL(native ? 'com.tracklog.assist://auth?next=%2Fsettings' : '/auth/driver/callback', origin);
      redirect.searchParams.set('candidate', id);
      // Replace the attempt atomically before cleaning old keys. A failed write
      // leaves the old recovery record intact (including its same-ID constraint).
      const a: Attempt = { id, redirect: redirect.href, expiresAt: now() + TTL, phase: 'choosing', requiredOwner: old?.phase === 'committing' ? old.owner : old?.requiredOwner };
      await withDriverAuthStorageMutation(() => Promise.resolve(write(a))); if (old) await clearKeys(old.id);
      const client = await clientFor(a);
      const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect.href, queryParams: { prompt: 'select_account' }, skipBrowserRedirect: true } });
      await current(id);
      if (error || !data.url) throw unavailable(); return data.url;
    }))),
    capture: (url: string) => serial(async () => { const { a } = await parse(url); if (a.phase !== 'committing') await write({ ...a, callback: url }); }),
    pending: async () => (await read())?.callback ?? null,
    handle: (url: string) => serial(async () => {
      const { parsed, a } = await parse(url);
      if (a.phase === 'committing') return;
      if (parsed.searchParams.has('error') || parsed.searchParams.has('error_code')) throw new Error('Googleログインが中止されました。仮ログインを取消して選び直してください。');
      const code = parsed.searchParams.get('code'); if (!code) throw unavailable();
      const client = await clientFor(a);
      const stored = await client.auth.getSession();
      // Resume after process death between SDK persistence and phase persistence.
      if (!stored.data.session) { const result = await client.auth.exchangeCodeForSession(code); if (result.error) throw unavailable(); }
      const value = await verifiedSession(a);
      await write({ ...a, phase: 'selected', owner: { id: value.user.id, email: value.user.email! }, callback: undefined });
    }),
    read: () => serial(async () => {
      const a = await read(); if (!a) return null;
      if (a.phase === 'committing') return { id: a.id, phase: a.phase, email: a.owner!.email };
      if (a.expiresAt <= now()) return { id: a.id, phase: 'expired' as const, email: null };
      if (a.phase === 'choosing') return { id: a.id, phase: a.phase, email: null };
      try { const s = await verifiedSession(a); return { id: a.id, phase: a.phase, email: s.user.email! }; }
      catch { return { id: a.id, phase: a.phase, email: null }; }
    }),
    discard: (expectedAttemptId?: string) => serial(async () => {
      const a = await read();
      if (expectedAttemptId !== undefined && a?.id !== expectedAttemptId) throw unavailable();
      if (!a) return;
      if (a.phase === 'committing') throw new Error('確定処理を開始しています。同じアカウントで再試行してください。');
      if (a.requiredOwner) await write({ ...a, phase: 'committing', owner: a.requiredOwner, handoff: undefined, callback: undefined });
      else await options.storage.removeItem(CANDIDATE_RECORD_KEY);
      await clearKeys(a.id); cached = null;
      // Never signOut (even local scope), revoke, delete user or unpin active.
    }),
    confirm: (check: (identity: Identity) => Promise<void>, promote: (session: Session | null, identity: Identity, adopted: () => Promise<void>) => Promise<void>, expectedAttemptId?: string) => serial(async () => {
      let a = await current(expectedAttemptId);
      if (a.phase === 'selected') {
        const value = await verifiedSession(a);
        const owner = { id: value.user.id, email: value.user.email! };
        await check(owner); await current(a.id);
        a = { ...a, phase: 'committing', owner, handoff: value, callback: undefined };
        await write(a);
      } else if (a.phase === 'committing') await check(a.owner!);
      else throw unavailable();
      // One-way handoff: no candidate SDK read/refresh beyond this point.
      await clearKeys(a.id); cached = null;
      const active = a;
      await promote(a.handoff ?? null, a.owner!, async () => {
        await current(active.id);
        await write({ ...active, handoff: undefined });
      });
      await current(a.id);
      await options.storage.removeItem(CANDIDATE_RECORD_KEY);
    }),
  };
}
let instance: ReturnType<typeof createDriverCandidateAuth> | null = null;
export function driverCandidateAuth() {
  const url = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim(), apiKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!url || !apiKey || typeof window === 'undefined') throw new Error('Supabase が未設定です');
  if (!navigator.locks) throw new Error('この環境では仮ログインを安全に開始できません。');
  return instance ??= createDriverCandidateAuth({ url, apiKey, storage: window.localStorage });
}

/** Presence only: never initializes the candidate SDK or refreshes a token. */
export function hasDriverCandidateAttempt(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(CANDIDATE_RECORD_KEY);
    if (!raw) return false;
    const record = JSON.parse(raw);
    return record.phase === 'committing' || !Number.isFinite(record.expiresAt) || record.expiresAt > Date.now();
  }
  catch { return true; }
}
