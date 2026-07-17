type Entry = { value: unknown; freshUntil: number; staleUntil: number };

const memory = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

export async function cachedData<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, staleSeconds = ttlSeconds * 2): Promise<T> {
  const current = Date.now();
  const local = memory.get(key);
  if (local && local.freshUntil > current) return local.value as T;
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-server-cache.internal/${encodeURIComponent(key)}`);
  if (cache) {
    try {
      const response = await cache.match(request);
      if (response) {
        const stored = await response.json() as Entry;
        if (stored.staleUntil > current) {
          memory.set(key, stored);
          if (stored.freshUntil > current) return stored.value as T;
        }
      }
    } catch {}
  }
  let promise = pending.get(key) as Promise<T> | undefined;
  if (!promise) {
    promise = (async () => {
      try {
        const value = await loader();
        const stored = {
          value,
          freshUntil: Date.now() + ttlSeconds * 1000,
          staleUntil: Date.now() + (ttlSeconds + Math.max(0, staleSeconds)) * 1000
        };
        memory.set(key, stored);
        if (cache) {
          try {
            await cache.put(request, new Response(JSON.stringify(stored), {
              headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds + Math.max(0, staleSeconds)}` }
            }));
          } catch {}
        }
        return value;
      } catch (error) {
        const stale = memory.get(key);
        if (stale && stale.staleUntil > Date.now()) return stale.value as T;
        throw error;
      }
    })().finally(() => pending.delete(key));
    pending.set(key, promise);
  }
  return promise;
}
