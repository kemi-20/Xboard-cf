export const now = () => Math.floor(Date.now() / 1000);
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});
export const ok = (data: unknown = true) => json({ data });
export const fail = (message = "Error", status = 400, code = 400) => json({ message, errors: message, code }, status);
export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("application/json")) return await request.json() as T;
  const out: Record<string, unknown> = {};
  const append = (key: string, value: unknown) => {
    if (!(key in out)) out[key] = value;
    else if (Array.isArray(out[key])) (out[key] as unknown[]).push(value);
    else out[key] = [out[key], value];
  };
  if (type.includes("application/x-www-form-urlencoded")) {
    new URLSearchParams(await request.text()).forEach((value, key) => append(key, value));
    return out as T;
  }
  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    form.forEach((value, key) => append(key, value));
    return out as T;
  }
  const raw = await request.text();
  if (raw) new URLSearchParams(raw).forEach((value, key) => append(key, value));
  return out as T;
}
export function uuid(): string {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16)
  );
}
export function token(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function getBearer(request: Request): string | null {
  const h = request.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return request.headers.get("x-token") || request.headers.get("token");
}
