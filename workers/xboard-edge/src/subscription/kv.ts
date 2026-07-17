import type { KVNamespace } from "./types.ts";
export async function bump(kv: KVNamespace, key: string) {
  await kv.put(key, String(Date.now()));
}
const memory = new Map<string, { value: unknown; expiresAt: number }>();
const pending = new Map<string, Promise<unknown>>();

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function cached<T>(_kv: KVNamespace, key: string, ttl: number, load: () => Promise<T>, shouldCache: (value: T) => boolean = () => true): Promise<T> {
  const cacheKey = await digest(key);
  const current = Date.now();
  const local = memory.get(cacheKey);
  if (local && local.expiresAt > current) return local.value as T;
  const cache = (globalThis as any).caches?.default;
  const request = new Request(`https://xboard-subscription-cache.internal/${cacheKey}`);
  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) {
        const value = await hit.json() as T;
        memory.set(cacheKey, { value, expiresAt: current + ttl * 1000 });
        return value;
      }
    } catch {
      // Subscription generation remains available when Cache API is unavailable.
    }
  }
  let promise = pending.get(cacheKey) as Promise<T> | undefined;
  if (!promise) {
    promise = (async () => {
      const value = await load();
      if (!shouldCache(value)) return value;
      memory.set(cacheKey, { value, expiresAt: Date.now() + ttl * 1000 });
      if (cache) {
        try {
          await cache.put(request, new Response(JSON.stringify(value), {
            headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` }
          }));
        } catch {
          // D1 and the generated subscription remain authoritative.
        }
      }
      return value;
    })().finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, promise);
  }
  return promise;
}
