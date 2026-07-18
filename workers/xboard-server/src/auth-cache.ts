const AUTH_CACHE_TTL_MS = 20_000;
const AUTH_CACHE_MAX_ENTRIES = 512;

type CacheEntry<T> = { value: T; expiresAt: number };

const authRows = new Map<string, CacheEntry<unknown>>();
const authLoads = new Map<string, Promise<unknown | null>>();

function pruneExpired(current: number) {
  for (const [key, entry] of authRows) {
    if (entry.expiresAt <= current) authRows.delete(key);
  }
  while (authRows.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authRows.keys().next().value;
    if (oldest === undefined) break;
    authRows.delete(oldest);
  }
}

export async function cachedAuthRow<T>(key: string, loader: () => Promise<T | null>): Promise<T | null> {
  const current = Date.now();
  const cached = authRows.get(key);
  if (cached && cached.expiresAt > current) return cached.value as T;
  if (cached) authRows.delete(key);

  const pending = authLoads.get(key);
  if (pending) return await pending as T | null;

  const load = loader()
    .then(value => {
      if (value !== null) {
        pruneExpired(Date.now());
        authRows.set(key, { value, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => authLoads.delete(key));
  authLoads.set(key, load);
  return await load;
}

export function invalidateAuthCache() {
  authRows.clear();
  authLoads.clear();
}
