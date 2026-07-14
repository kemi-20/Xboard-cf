import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { __test } from "../src/index.ts";

test("xboard-subscription has an entrypoint", () => {
  assert.ok(fs.existsSync("src/index.ts"));
  assert.match(fs.readFileSync("src/index.ts", "utf8"), /export default/);
});

test("legacy client subscribe reads the query token instead of the route name", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /url\.pathname === "\/api\/v1\/client\/subscribe"[\s\S]*url\.searchParams\.get\("token"\)/);
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
  assert.match(source, /subscribe:v3:\$\{token\}:\$\{client\}:\$\{variant\}/);
  assert.match(source, /templatesVersion/);
});

test("plain browser subscriptions display inline like upstream General", () => {
  const headers = __test.responseHeaders("plain", { app_name: "XBoard" }, { u: 1, d: 2, transfer_enable: 3, expired_at: 4 });
  assert.equal(headers["content-type"], "text/plain");
  assert.equal(headers["content-disposition"], undefined);
  assert.equal(headers["profile-update-interval"], undefined);
  assert.equal(headers["subscription-userinfo"], "upload=1; download=2; total=3; expire=4");
});

test("subscription response headers follow each upstream protocol", () => {
  const user = { u: 1, d: 2, transfer_enable: 3, expired_at: 4 };
  const config = { app_name: "Board Name", app_url: "https://panel.example" };
  assert.match(__test.responseHeaders("clash", config, user)["content-disposition"], /^attachment;/);
  assert.equal(__test.responseHeaders("clash", config, user)["profile-web-page-url"], config.app_url);
  assert.equal(__test.responseHeaders("clashmeta", config, user)["profile-web-page-url"], undefined);
  assert.equal(__test.responseHeaders("singbox", config, user)["content-disposition"], undefined);
  assert.equal(__test.responseHeaders("surge", config, user)["subscription-userinfo"], undefined);
  assert.equal(__test.responseHeaders("surfboard", config, user)["content-type"], "text/html; charset=UTF-8");
  assert.equal(__test.responseHeaders("shadowrocket", config, user)["subscription-userinfo"], undefined);
});

test("client matching and encoded formats follow upstream flags", () => {
  assert.equal(__test.clientOf(new Request("https://sub.example/s/token", { headers: { "user-agent": "Mozilla/5.0" } })), "plain");
  assert.equal(__test.clientOf(new Request("https://sub.example/s/token?flag=shadowsocks")), "shadowsocks");
  assert.equal(__test.clientOf(new Request("https://sub.example/s/token?flag=quantumult-x")), "quantumultx");
  const user = { uuid: "00000000-0000-4000-8000-000000000000", u: 0, d: 0, transfer_enable: 1 };
  const server = { id: 1, type: "shadowsocks", name: "Node", host: "127.0.0.1", port: 8388, protocol_settings: { cipher: "aes-128-gcm" } };
  const quantumult = __test.output("quantumultx", {}, {}, user, [server], new Request("https://sub.example/s/token"), "token");
  assert.match(quantumult, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.deepEqual(JSON.parse(__test.shadowsocksProfile(user, [server])).servers[0], {
    id: 1, remarks: "Node", server: "127.0.0.1", server_port: 8388,
    password: user.uuid, method: "aes-128-gcm"
  });
});

test("subscription preparation follows upstream expiry, group, dynamic-port and SS-2022 rules", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /user\.expired_at !== null/);
  assert.match(source, /user\.plan_id === null/);
  assert.match(source, /groups\.includes\(Number\(user\.group_id/);
  const selected = __test.randomizedPort("2000-1000");
  assert.ok(selected.port >= 1000 && selected.port <= 2000);
  assert.equal(selected.ports, "2000-1000");
  const password = __test.serverPassword({ type: "shadowsocks", created_at: 1700000000, protocol_settings: { cipher: "2022-blake3-aes-128-gcm" } }, { uuid: "00000000-0000-4000-8000-000000000000" }, new Map());
  assert.match(password, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
});

test("QuantumultX and Loon use their official line formats", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const server = { type: "shadowsocks", name: "Node", host: "127.0.0.1", port: 8388, password: "node-password", protocol_settings: { cipher: "aes-128-gcm" } };
  assert.match(__test.quantumultXLine(user, server), /^shadowsocks=127\.0\.0\.1:8388,method=aes-128-gcm,password=node-password,/);
  assert.match(__test.loonLine(user, server), /^Node=Shadowsocks,127\.0\.0\.1,8388,aes-128-gcm,node-password,/);
});

test("client output filters protocols using upstream allowlists", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000", u: 0, d: 0, transfer_enable: 1 };
  const servers = [
    { type: "vless", name: "VLESS", host: "vless.example", port: 443, protocol_settings: {} },
    { type: "trojan", name: "Trojan", host: "trojan.example", port: 443, protocol_settings: {} }
  ];
  const classic = __test.output("clash", {}, { clash: "proxies: []\nproxy-groups: []\nrules: []\n" }, user, servers, new Request("https://sub.example/s/token"), "token");
  assert.doesNotMatch(classic, /VLESS/);
  assert.match(classic, /Trojan/);
  const meta = __test.output("clashmeta", {}, { clashmeta: "proxies: []\nproxy-groups: []\nrules: []\n" }, user, servers, new Request("https://sub.example/s/token"), "token");
  assert.match(meta, /VLESS/);
  assert.match(meta, /Trojan/);
});

test("invalid type filters behave like upstream and do not hide all nodes", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /filter\(value => validServerTypes\.has\(value\)\)/);
  assert.match(source, /requestedTypes\.length && !requestedTypes\.includes\(server\.type\)/);
});

test("subscription generation survives KV quota and cache failures", () => {
  const source = fs.readFileSync("src/kv.ts", "utf8");
  assert.match(source, /try[\s\S]*await kv\.get\(key\)[\s\S]*catch/);
  assert.match(source, /const value = await load\(\)/);
  assert.match(source, /try[\s\S]*await kv\.put\(key[\s\S]*catch/);
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

test("VMess and Trojan complex transports survive Clash, Surge and Shadowrocket rendering", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000", u: 0, d: 0, transfer_enable: 1, expired_at: null };
  const vmess = { type: "vmess", name: "VMess WS", host: "vmess.example.com", port: 443, protocol_settings: { tls: 1, tls_settings: { server_name: "cdn.example.com", allow_insecure: true }, network: "ws", network_settings: { path: "/ws", headers: { Host: "edge.example.com" } }, utls: { enabled: true, fingerprint: "chrome" }, multiplex: { enabled: true, protocol: "yamux" } } };
  const clash = __test.clashProxy(user, vmess);
  assert.equal(clash.network, "ws");
  assert.equal(clash["ws-opts"].path, "/ws");
  assert.equal(clash["ws-opts"].headers.Host, "edge.example.com");
  assert.equal(clash["client-fingerprint"], "chrome");
  assert.equal(clash.smux.enabled, true);
  const surge = __test.proxyLine(user, vmess, "surge");
  assert.match(surge, /tls=true/);
  assert.match(surge, /ws=true/);
  assert.match(surge, /ws-path=\/ws/);
  const shadowrocket = __test.shadowrocketLine(user, vmess);
  assert.match(shadowrocket, /^vmess:\/\//);
  assert.match(shadowrocket, /obfs=websocket/);
});

test("Sing-box selectors honor include, exclude and fallback and protocol-specific fields", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const servers = [
    { type: "hysteria", name: "HK Hysteria", host: "hk.example.com", port: 443, password: "secret", ports: "2000-3000", protocol_settings: { version: 2, bandwidth: { up: 100, down: 200 }, hop_interval: 15, tls: { server_name: "hk.example.com" }, obfs: { open: true, type: "salamander", password: "obfs" } } },
    { type: "socks", name: "US Socks", host: "us.example.com", port: 1080, protocol_settings: { udp_over_tcp: true } }
  ];
  const rendered = JSON.parse(__test.singboxProfile(JSON.stringify({ outbounds: [
    { type: "selector", tag: "HK", outbounds: [], include: "HK|香港" },
    { type: "selector", tag: "JP", outbounds: [], include: "JP", fallback: "direct" },
    { type: "direct", tag: "direct" }
  ] }), user, servers));
  assert.deepEqual(rendered.outbounds.find(item => item.tag === "HK").outbounds, ["HK Hysteria"]);
  assert.deepEqual(rendered.outbounds.find(item => item.tag === "JP").outbounds, ["direct"]);
  const hysteria = rendered.outbounds.find(item => item.tag === "HK Hysteria");
  assert.equal(hysteria.type, "hysteria2");
  assert.equal(hysteria.up_mbps, 100);
  assert.deepEqual(hysteria.server_ports, ["2000:3000"]);
  assert.equal(hysteria.obfs.type, "salamander");
  const socks = rendered.outbounds.find(item => item.tag === "US Socks");
  assert.equal(socks.version, "5");
  assert.equal(socks.udp_over_tcp, true);
});

test("QuantumultX user agents and disabled template fallbacks match upstream behavior", () => {
  const source = fs.readFileSync("src/index.ts", "utf8");
  assert.match(source, /flag\.includes\("quantumultx"\)/);
  assert.doesNotMatch(source, /quantumult%20x/);
  assert.match(source, /SELECT name, COALESCE\(content, ''\) AS content FROM v2_subscribe_templates WHERE enabled = 1/);
});
