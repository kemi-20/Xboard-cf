export const OFFICIAL_HTTP_ROUTES = [
  "GET /api/v1/server/UniProxy/config",
  "GET /api/v1/server/UniProxy/user",
  "POST /api/v1/server/UniProxy/push",
  "POST /api/v1/server/UniProxy/alive",
  "GET /api/v1/server/UniProxy/alivelist",
  "POST /api/v1/server/UniProxy/status",
  "GET /api/v1/server/ShadowsocksTidalab/user",
  "POST /api/v1/server/ShadowsocksTidalab/submit",
  "GET /api/v1/server/TrojanTidalab/config",
  "GET /api/v1/server/TrojanTidalab/user",
  "POST /api/v1/server/TrojanTidalab/submit",
  "GET /api/v2/server/handshake",
  "POST /api/v2/server/handshake",
  "POST /api/v2/server/report",
  "GET /api/v2/server/config",
  "GET /api/v2/server/user",
  "POST /api/v2/server/push",
  "POST /api/v2/server/alive",
  "GET /api/v2/server/alivelist",
  "POST /api/v2/server/status",
  "POST /api/v2/server/machine/nodes",
  "POST /api/v2/server/machine/status"
] as const;

export const OFFICIAL_WS_EVENTS = [
  "auth.success", "error", "ping", "pong", "sync.config", "sync.users",
  "sync.user.delta", "sync.nodes", "sync.devices", "node.status",
  "report.devices", "request.devices"
] as const;
