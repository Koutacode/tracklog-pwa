import { createClient } from '@supabase/supabase-js';

// Six upstream map attempts can take about 27 seconds. Include body reads and
// any transport work in the limit, not only the arrival of response headers.
export const IC_RESOLVER_REQUEST_TIMEOUT_MS = 35_000;

export async function withIcResolverTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = IC_RESOLVER_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('IC取得の通信がタイムアウトしました。自動で再試行します'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Uses only the caller's already acquired token; never restores another session. */
export function createIcResolverFunctionInvoker(
  url: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
) {
  const client = createClient(url, apiKey, {
    // supabase-js calls getAccessToken even when Authorization is provided.
    // A stateless client prevents a second native refresh blocking this read.
    accessToken: async () => null,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
  return <T>(accessToken: string, body: Record<string, unknown>, timeoutMs?: number) =>
    withIcResolverTimeout(signal => client.functions.invoke<T>('tracklog-ic-resolver', {
      body,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    }), timeoutMs);
}

const url = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const apiKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();
export const invokeIcResolverFunction = url && apiKey
  ? createIcResolverFunctionInvoker(url, apiKey)
  : null;
