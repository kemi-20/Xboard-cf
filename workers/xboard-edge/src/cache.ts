type ResponseCacheEntry = { value: unknown; freshUntil: number; staleUntil: number };

const responseDataCache = new Map<string, ResponseCacheEntry>();
const responseDataPromises = new Map<string, Promise<unknown>>();

export async function cachedData<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, staleSeconds = ttlSeconds * 2): Promise<T> {
  const current = Date.now();
  const memory = responseDataCache.get(key);
  if (memory && memory.freshUntil > current) return memory.value as T;
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-cache.internal/${encodeURIComponent(key)}`);
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const stored = await hit.json() as { value: T; freshUntil: number; staleUntil: number };
        if (stored && stored.staleUntil > current) {
          responseDataCache.set(key, stored);
          if (stored.freshUntil > current) return stored.value;
        }
      }
    } catch {}
  }
  let pending = responseDataPromises.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = (async () => {
      try {
        const value = await loader();
        const stored = {
          value,
          freshUntil: Date.now() + ttlSeconds * 1000,
          staleUntil: Date.now() + (ttlSeconds + Math.max(0, staleSeconds)) * 1000
        };
        responseDataCache.set(key, stored);
        if (cache) {
          try {
            await cache.put(request, new Response(JSON.stringify(stored), {
              headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds + Math.max(0, staleSeconds)}` }
            }));
          } catch {}
        }
        return value;
      } catch (error) {
        const stale = responseDataCache.get(key);
        if (stale && stale.staleUntil > Date.now()) return stale.value as T;
        throw error;
      }
    })().finally(() => responseDataPromises.delete(key));
    responseDataPromises.set(key, pending);
  }
  return pending;
}
