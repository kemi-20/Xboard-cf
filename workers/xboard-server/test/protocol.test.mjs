import test from "node:test";
import assert from "node:assert/strict";
import {
  availableUser, buildNodeConfig, md5, normalizeNodeType,
  parseTraffic, responseEtag, shadowsocksServerKey
} from "../src/protocol.ts";

test("normalizes official node type aliases", () => {
  assert.equal(normalizeNodeType("v2ray"), "vmess");
  assert.equal(normalizeNodeType("hysteria2"), "hysteria");
  assert.equal(normalizeNodeType("v2node"), null);
});

test("matches the PHP MD5 based Shadowsocks server key algorithm", () => {
  assert.equal(md5("test"), "098f6bcd4621d373cade4e832627b4f6");
  assert.equal(shadowsocksServerKey(1700000000, 16), Buffer.from(md5("1700000000").slice(0, 16)).toString("base64"));
});

test("builds the official VLESS node configuration shape", () => {
  const config = buildNodeConfig({
    id: 1, type: "vless", host: "node.example.com", server_port: 443,
    protocol_settings: JSON.stringify({
      tls: 2, flow: "xtls-rprx-vision", network: "tcp", network_settings: {},
      encryption: { enabled: true, decryption: "private" },
      reality_settings: { server_name: "www.example.com", private_key: "key" },
      multiplex: { enabled: false }
    }),
    route_ids: "[2]", custom_outbounds: "[]", custom_routes: "[]", cert_config: null
  }, [{ id: 2, match: '["domain:example.com"]', action: "block", action_value: null }]);
  assert.deepEqual(config, {
    protocol: "vless", listen_ip: "0.0.0.0", server_port: 443, network: "tcp", networkSettings: {},
    tls: 2, flow: "xtls-rprx-vision", decryption: "private",
    tls_settings: { server_name: "www.example.com", private_key: "key" }, multiplex: { enabled: false },
    routes: [{ id: 2, match: ["domain:example.com"], action: "block", action_value: null }]
  });
});

test("builds every protocol accepted by the official node client", () => {
  const settings = {
    shadowsocks: { cipher: "aes-128-gcm", plugin: null, plugin_opts: null },
    vmess: { tls: 0, network: "tcp", network_settings: {}, tls_settings: {}, multiplex: {} },
    trojan: { tls: 1, network: "tcp", network_settings: {}, tls_settings: { server_name: "sni" }, multiplex: {} },
    vless: { tls: 0, network: "tcp", network_settings: {}, tls_settings: {}, flow: "", encryption: {}, multiplex: {} },
    hysteria: { version: 2, bandwidth: { up: 100, down: 100 }, obfs: { open: false }, tls: { server_name: "sni" } },
    tuic: { version: 5, congestion_control: "cubic", tls: { server_name: "sni" } },
    anytls: { tls: { server_name: "sni" }, padding_scheme: ["stop=8"] },
    socks: { tls: 0, tls_settings: {} }, naive: { tls: 1, tls_settings: {} }, http: { tls: 1, tls_settings: {} },
    mieru: { transport: "TCP", traffic_pattern: "" }
  };
  for (const [type, protocolSettings] of Object.entries(settings)) {
    const config = buildNodeConfig({ type, host: "host", server_port: 443, created_at: 1700000000, protocol_settings: protocolSettings });
    assert.equal(config.protocol, type);
    assert.equal(config.server_port, 443);
  }
});

test("filters traffic payload entries to the official two-counter format", () => {
  assert.deepEqual(parseTraffic({ "1": [10, 20], token: "x", "2": [30], "3": [-5, 8] }), [
    { user_id: 1, u: 10, d: 20 }, { user_id: 3, u: 0, d: 8 }
  ]);
  assert.deepEqual(parseTraffic([null, [11, 22], [33, 44]]), [
    { user_id: 1, u: 11, d: 22 }, { user_id: 2, u: 33, d: 44 }
  ]);
});

test("returns only official user fields", () => {
  assert.deepEqual(availableUser({ id: "7", uuid: "u", speed_limit: null, device_limit: "3", email: "hidden" }), {
    id: 7, uuid: "u", speed_limit: null, device_limit: 3
  });
});

test("ETag uses PHP json_encode escaping", async () => {
  assert.equal(await responseEtag({ message: "中文/😀" }), '"d73f031c258799442f6ebfc0af123f028f279b2a"');
});

test("empty certificate configuration is omitted like upstream", () => {
  const base = { type: "vmess", host: "node.example", server_port: 443, protocol_settings: { network: "tcp" } };
  assert.equal(buildNodeConfig({ ...base, cert_config: { mode: null } }).cert_config, undefined);
  assert.equal(buildNodeConfig({ ...base, cert_config: { mode: "none" } }).cert_config, undefined);
  assert.deepEqual(buildNodeConfig({ ...base, cert_config: { mode: "file", cert: "/cert.pem" } }).cert_config, { cert_mode: "file", cert: "/cert.pem" });
});
