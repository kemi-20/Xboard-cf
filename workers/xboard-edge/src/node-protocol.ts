const v2NodeProtocolPaths = new Set([
  "/api/v2/server/handshake", "/api/v2/server/report", "/api/v2/server/config",
  "/api/v2/server/user", "/api/v2/server/push", "/api/v2/server/alive",
  "/api/v2/server/alivelist", "/api/v2/server/status",
  "/api/v2/server/machine/nodes", "/api/v2/server/machine/status"
]);

export function isNodeProtocolPath(pathname: string, method = "GET") {
  if (pathname === "/ws" || pathname.startsWith("/api/v1/server/")) return true;
  if (pathname === "/api/v2/server/machine/nodes" || pathname === "/api/v2/server/machine/status") return method === "POST";
  return v2NodeProtocolPaths.has(pathname);
}
