import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __test } from "../src/index.ts";

test("xboard-subscription has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("subscription output reads saved settings and templates", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /await loadSettings\(env\.XBOARD_DB\)/);
  assert.match(source, /FROM v2_subscribe_templates/);
  assert.match(source, /show_info_to_server_enable/);
  assert.match(source, /show_protocol_to_server_enable/);
  assert.match(source, /templateMap\[client\]/);
  assert.match(source, /replaceAll\("\$app_name"/);
});

test("subscription cache varies by filters and hostname", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /searchParams\.get\("types"\)/);
  assert.match(source, /searchParams\.get\("filter"\)/);
  assert.match(source, /url\.hostname/);
  assert.match(source, /subscribe:\$\{token\}:\$\{client\}:\$\{variant\}/);
});

test("subscription settings decorate server names like upstream", () => {
  const servers = __test.decorateServers([
    { id: 1, type: "vless", name: "Hong Kong", protocol_settings: { version: 1 } }
  ], {
    u: 1073741824,
    d: 0,
    transfer_enable: 10737418240,
    expired_at: 1893456000
  }, {
    show_info_to_server_enable: "1",
    show_protocol_to_server_enable: "1"
  }, 0);
  assert.equal(servers.length, 3);
  assert.match(servers[0].name, /^\[vless\]剩余流量：9 GB$/);
  assert.match(servers[1].name, /^\[vless\]套餐到期：2030-01-01$/);
  assert.equal(servers[2].name, "[vless]Hong Kong");
});

test("saved Clash template controls rendered subscription", () => {
  const rendered = __test.yamlProfile("clash", `mixed-port: 17890\nproxy-groups:\n  - name: $app_name\n    type: select\n    proxies: []\nrules:\n  - DOMAIN-SUFFIX,custom.example,DIRECT\n`, { app_name: "Custom Board" }, {
    uuid: "00000000-0000-4000-8000-000000000000"
  }, [{ type: "vless", name: "Node A", host: "example.com", port: 443, protocol_settings: { tls: 1, network: "tcp" } }], new Request("https://sub.example/s/token"));
  assert.match(rendered, /mixed-port: 17890/);
  assert.match(rendered, /Custom Board/);
  assert.match(rendered, /custom\.example/);
  assert.match(rendered, /Node A/);
});

test("saved Surge template placeholders are replaced", () => {
  const rendered = __test.textTemplateProfile("surge", "$app_name\n$subs_link\n$proxies\n$proxy_group\n$subscribe_info", { app_name: "Custom Board", subscribe_url: "https://subscribe.example", subscribe_path: "custom-sub" }, { uuid: "uuid", u: 0, d: 0, transfer_enable: 1073741824, expired_at: null }, [{ type: "shadowsocks", name: "Node A", host: "127.0.0.1", port: 8388, protocol_settings: { cipher: "aes-128-gcm" } }], new Request("https://worker.example/s/token"), "token");
  assert.match(rendered, /Custom Board/);
  assert.match(rendered, /https:\/\/subscribe\.example\/custom-sub\/token/);
  assert.match(rendered, /Node A = ss/);
  assert.doesNotMatch(rendered, /\$(app_name|subs_link|proxies|proxy_group|subscribe_info)/);
});

const realityVless = {
  type: "vless",
  name: "Reality Node",
  host: "node.example.com",
  port: 443,
  protocol_settings: {
    tls: 2,
    flow: "xtls-rprx-vision",
    encryption: { enabled: true, encryption: "mlkem768x25519plus.native.0rtt" },
    reality_settings: {
      public_key: "reality-public-key",
      short_id: "0123456789abcdef",
      server_name: "www.example.com"
    },
    utls: { enabled: true, fingerprint: "chrome" },
    network: "ws",
    network_settings: { path: "/socket", headers: { Host: "cdn.example.com" } },
    multiplex: {
      enabled: true,
      protocol: "yamux",
      max_connections: 4,
      padding: true,
      brutal: { enabled: true, up_mbps: 100, down_mbps: 200 }
    }
  }
};

test("general subscription is Base64 encoded and preserves official VLESS fields", () => {
  const encoded = __test.general({ uuid: "00000000-0000-4000-8000-000000000000" }, [realityVless]);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const uri = new URL(decoded.trim());
  assert.equal(uri.protocol, "vless:");
  assert.equal(uri.searchParams.get("security"), "reality");
  assert.equal(uri.searchParams.get("pbk"), "reality-public-key");
  assert.equal(uri.searchParams.get("sid"), "0123456789abcdef");
  assert.equal(uri.searchParams.get("sni"), "www.example.com");
  assert.equal(uri.searchParams.get("servername"), "www.example.com");
  assert.equal(uri.searchParams.get("spx"), "/");
  assert.equal(uri.searchParams.get("fp"), "chrome");
  assert.equal(uri.searchParams.get("flow"), "xtls-rprx-vision");
  assert.equal(uri.searchParams.get("encryption"), "mlkem768x25519plus.native.0rtt");
  assert.equal(uri.searchParams.get("type"), "ws");
  assert.equal(uri.searchParams.get("path"), "/socket");
  assert.equal(uri.searchParams.get("host"), "cdn.example.com");
});

test("general URI credentials follow upstream formats", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const socks = __test.generalUri(user, { type: "socks", name: "SOCKS", host: "127.0.0.1", port: 1080, protocol_settings: {} });
  const socksAuth = socks.match(/^socks:\/\/([^@]+)@/)?.[1];
  assert.equal(Buffer.from(socksAuth, "base64").toString("utf8"), `${user.uuid}:${user.uuid}`);
  const tuic = __test.generalUri(user, { type: "tuic", name: "TUIC", host: "node.example.com", port: 443, protocol_settings: {} });
  assert.match(tuic, new RegExp(`^tuic://${user.uuid}:${user.uuid}@node\\.example\\.com:443\\?`));
});

test("ClashMeta VLESS output includes Reality, transport and multiplex settings", () => {
  const proxy = __test.clashProxy({ uuid: "00000000-0000-4000-8000-000000000000" }, realityVless);
  assert.equal(proxy.tls, true);
  assert.equal(proxy["reality-opts"]["public-key"], "reality-public-key");
  assert.equal(proxy["reality-opts"]["short-id"], "0123456789abcdef");
  assert.equal(proxy["client-fingerprint"], "chrome");
  assert.equal(proxy.flow, "xtls-rprx-vision");
  assert.equal(proxy.encryption, "mlkem768x25519plus.native.0rtt");
  assert.equal(proxy.network, "ws");
  assert.equal(proxy["ws-opts"].path, "/socket");
  assert.equal(proxy["ws-opts"].headers.Host, "cdn.example.com");
  assert.equal(proxy.smux.enabled, true);
  assert.equal(proxy.smux["max-connections"], 4);
  assert.equal(proxy.smux["brutal-opts"].up, 100);
});

test("Sing-box VLESS output includes Reality, uTLS, transport and multiplex settings", () => {
  const outbound = __test.singboxOutbound({ uuid: "00000000-0000-4000-8000-000000000000" }, realityVless);
  assert.equal(outbound.packet_encoding, "xudp");
  assert.equal(outbound.flow, "xtls-rprx-vision");
  assert.equal(outbound.tls.reality.enabled, true);
  assert.equal(outbound.tls.reality.public_key, "reality-public-key");
  assert.equal(outbound.tls.reality.short_id, "0123456789abcdef");
  assert.equal(outbound.tls.utls.fingerprint, "chrome");
  assert.equal(outbound.transport.type, "ws");
  assert.equal(outbound.transport.path, "/socket");
  assert.equal(outbound.transport.headers.Host, "cdn.example.com");
  assert.equal(outbound.transport.max_early_data, 0);
  assert.equal(outbound.multiplex.enabled, true);
  assert.equal(outbound.multiplex.max_connections, 4);
  assert.equal(outbound.multiplex.brutal.down_mbps, 200);
});
