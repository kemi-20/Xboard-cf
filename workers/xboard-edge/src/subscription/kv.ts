import type { KVNamespace } from "./types.ts";
import { sha256Hex } from "./compat.ts";
type Entry = { value: unknown; freshUntil: number; staleUntil: number };

const memory = new Map<string, Entry>();
const pending = new Map<string, Promise<unknown>>();

export async function cached<T>(_kv: KVNamespace, key: string, ttl: number, load: () => Promise<T>, shouldCache: (value: T) => boolean = () => true, staleSeconds = ttl * 2): Promise<T> {
  const cacheKey = await sha256Hex(key);
  const current = Date.now();
  const local = memory.get(cacheKey);
  if (local && local.freshUntil > current) return local.value as T;
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-subscription-cache.internal/${cacheKey}`);
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const stored = await hit.json() as Entry;
        if (stored && typeof stored === "object" && "freshUntil" in stored && stored.staleUntil > current) {
          memory.set(cacheKey, stored);
          if (stored.freshUntil > current) return stored.value as T;
        }
      }
    } catch {
      // Subscription generation remains available when Cache API is unavailable.
    }
  }
  let promise = pending.get(cacheKey) as Promise<T> | undefined;
  if (!promise) {
    promise = (async () => {
      try {
        const value = await load();
        if (!shouldCache(value)) return value;
        const stored = {
          value,
          freshUntil: Date.now() + ttl * 1000,
          staleUntil: Date.now() + (ttl + Math.max(0, staleSeconds)) * 1000
        };
        memory.set(cacheKey, stored);
        if (cache) {
          try {
            await cache.put(request, new Response(JSON.stringify(stored), {
              headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl + Math.max(0, staleSeconds)}` }
            }));
          } catch {
            // D1 and the generated subscription remain authoritative.
          }
        }
        return value;
      } catch (error) {
        const stale = memory.get(cacheKey);
        if (stale && stale.staleUntil > Date.now()) return stale.value as T;
        throw error;
      }
    })().finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, promise);
  }
  return promise;
}
