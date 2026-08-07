const OBFUSCATED_ROUTE = /^\/([A-Za-z0-9_-]{1,32})\/([A-Za-z0-9_-]{1,4096})(\/.*)?$/;
const TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ObfuscatedApiRequest {
  request: Request;
  originalPath: string;
  parameterMode: "skip" | "append";
}

export type ObfuscatedApiRoute = ObfuscatedApiRequest | Response | null;

function base64UrlText(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function decodeObfuscatedApiRequest(request: Request, currentTime = Math.floor(Date.now() / 1000)): ObfuscatedApiRoute {
  const incoming = new URL(request.url);
  const match = incoming.pathname.match(OBFUSCATED_ROUTE);
  if (!match) return null;

  let timestampText: string;
  try {
    timestampText = base64UrlText(match[1]);
  } catch {
    return null;
  }
  if (!/^\d{1,12}$/.test(timestampText)) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp) || Math.abs(currentTime - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
      return jsonError("Timestamp expired", 401);
    }

    const apiPath = base64UrlText(match[2]);
    if (!apiPath || /[\u0000-\u001f\u007f]/.test(apiPath)) return jsonError("Invalid API path", 400);
    const remainingPath = match[3] || "";
    const originalPath = `/api/v1/${apiPath}${remainingPath}`;
    const target = new URL(originalPath, incoming.origin);
    if (!target.pathname.startsWith("/api/v1/")) return jsonError("Invalid API path", 400);

    const parameterMode = originalPath.includes("?") ? "skip" : "append";
    if (parameterMode === "append") {
      incoming.searchParams.forEach((value, key) => target.searchParams.append(key, value));
    }

    const rewritten = new Request(target.toString(), request);
    rewritten.headers.set("x-original-path", originalPath);
    rewritten.headers.set("x-original-timestamp", timestampText);
    return {
      request: rewritten,
      originalPath,
      parameterMode
    };
  } catch {
    return jsonError("Invalid obfuscated request", 400);
  }
}

export function decorateObfuscatedApiResponse(response: Response, route: ObfuscatedApiRequest) {
  const headers = new Headers(response.headers);
  headers.set("x-original-path", route.originalPath);
  headers.set("x-proxy-server", "xboard-edge");
  headers.set("x-param-handler", route.parameterMode);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
