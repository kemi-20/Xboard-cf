export const now = () => Math.floor(Date.now() / 1000);
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});
export const ok = (data: unknown = true) => json({ data });
export const fail = (message = "Error", status = 400, code = 400) => json({ message, errors: message, code }, status);
export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) return await request.json() as T;
  const form = await request.formData();
  const out: Record<string, unknown> = {};
  form.forEach((value, key) => { out[key] = value; });
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
export function getBearer(request: Request): string | null {
  const h = request.headers.get("authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return request.headers.get("x-token") || request.headers.get("token");
}
