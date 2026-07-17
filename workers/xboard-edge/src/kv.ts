import type { KVNamespace } from "./types";
export async function bump(kv: KVNamespace, key: string) {
  try {
    await kv.put(key, String(Date.now()));
  } catch {
    // Version keys only invalidate caches; D1 writes must still succeed when KV is unavailable or over quota.
  }
}
