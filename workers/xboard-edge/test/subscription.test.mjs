import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { __test } from "../src/subscription/index.ts";

test("xboard-edge contains the subscription handler", () => {
  assert.ok(fs.existsSync("src/subscription/index.ts"));
  assert.match(fs.readFileSync("src/subscription/index.ts", "utf8"), /export async function handleSubscriptionRequest/);
});

test("legacy client subscribe reads the query token instead of the route name", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /url\.pathname === "\/api\/v1\/client\/subscribe"[\s\S]*url\.searchParams\.get\("token"\)/);
});

test("saved subscription paths are enforced instead of accepting arbitrary aliases", () => {
  assert.equal(__test.matchesConfiguredSubscribePath("/custom/token", "custom"), true);
  assert.equal(__test.matchesConfiguredSubscribePath("/s/token", "custom"), false);
  assert.equal(__test.matchesConfiguredSubscribePath("/custom/a/b", "custom"), false);
  assert.equal(__test.matchesConfiguredSubscribePath("/s/token", ""), true);
});

test("subscription output reads saved settings and templates", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /loadSettings\(env\.XBOARD_DB\)/);
  assert.match(source, /FROM v2_subscribe_templates/);
  assert.match(source, /show_info_to_server_enable/);
  assert.match(source, /show_protocol_to_server_enable/);
  assert.match(source, /templateMap\[client\]/);
  assert.match(source, /replaceAll\("\$app_name"/);
});

test("Clash and Sing-box protocol details match upstream edge cases", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const base = { id: 1, name: "Node", host: "node.example", port: 443, password: "secret" };
  const socks = __test.singboxOutbound(user, { ...base, type: "socks", protocol_settings: { tls: 1, tls_settings: { server_name: "wrong.example" } } });
  assert.equal(socks.tls, undefined);

  const pem = "-----BEGIN ECH CONFIGS-----\nYWJj ZA==\n-----END ECH CONFIGS-----";
  const vless = __test.clashProxy(user, { ...base, type: "vless", protocol_settings: { tls: 1, tls_settings: { ech: { enabled: 1, config: pem, query_server_name: " ech.example " } }, network: "xhttp", network_settings: {} } }, "clashmeta");
  assert.deepEqual(vless["ech-opts"], { enable: true, config: "YWJjZA==", "query-server-name": "ech.example" });
  assert.equal(vless["xhttp-opts"], undefined);

  const anytls = __test.clashProxy(user, { ...base, type: "anytls", protocol_settings: { tls: { server_name: "tls.example", ech: { enabled: true, config: " Zm9v \n" } } } }, "clashmeta");
  assert.deepEqual(anytls["ech-opts"], { enable: true, config: "Zm9v" });

  const vmess = __test.clashProxy(user, { ...base, type: "vmess", protocol_settings: { network: "httpupgrade", network_settings: {} } }, "clashmeta");
  assert.equal(vmess["ws-opts"].headers, undefined);

  const hysteria = __test.clashProxy(user, { ...base, type: "hysteria", protocol_settings: { version: 2, hop_interval: 0, tls: {} } }, "clashmeta");
  assert.equal(hysteria["hop-interval"], undefined);

  const limitedHysteria = __test.clashProxy(user, { ...base, type: "hysteria", protocol_settings: { version: 2, bandwidth: { up: 25, down: 100 }, tls: {} } }, "clashmeta");
  assert.equal(limitedHysteria.up, 25);
  assert.equal(limitedHysteria.down, 100);
});

test("inactive Reality settings never override the active standard TLS SNI", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const server = {
    id: 12,
    type: "vless",
    name: "US 2-2",
    host: "edge.example",
    port: 443,
    protocol_settings: {
      tls: 1,
      tls_settings: { server_name: "us2.example.com", allow_insecure: false },
      reality_settings: { server_name: "apple.com", allow_insecure: true, public_key: "stale", short_id: "stale" },
      network: "ws",
      network_settings: { path: "/cadillac", headers: { Host: "us2.example.com" } }
    }
  };
  const clash = __test.clashProxy(user, server, "clashmeta");
  assert.equal(clash.servername, "us2.example.com");
  assert.equal(clash["skip-cert-verify"], false);
  assert.equal(clash["reality-opts"], undefined);
  const singbox = __test.singboxOutbound(user, server);
  assert.equal(singbox.tls.server_name, "us2.example.com");
  assert.equal(singbox.tls.insecure, false);
  assert.equal(singbox.tls.reality, undefined);

  const trojan = { ...server, type: "trojan" };
  assert.equal(__test.clashProxy(user, trojan, "clashmeta").sni, "us2.example.com");
  assert.match(__test.proxyLine(user, trojan, "surge"), /sni=us2\.example\.com/);
  assert.doesNotMatch(__test.proxyLine(user, trojan, "surge"), /apple\.com/);

  const realityTrojan = { ...trojan, protocol_settings: { ...trojan.protocol_settings, tls: 2 } };
  assert.equal(__test.clashProxy(user, realityTrojan, "clash").sni, "us2.example.com");
  assert.equal(__test.clashProxy(user, realityTrojan, "clash")["reality-opts"], undefined);
  assert.equal(__test.clashProxy(user, realityTrojan, "clashmeta").sni, "apple.com");

  const realityVless = { ...server, protocol_settings: { ...server.protocol_settings, tls: 2 } };
  const stash = __test.clashProxy(user, realityVless, "stash");
  assert.equal(stash.servername, "apple.com");
  assert.equal(stash.sni, "apple.com");
});

test("sing-box slash user agents retain their actual core version", () => {
  assert.equal(__test.singboxCoreVersion("sing-box/1.8.0"), "1.8.0");
  assert.equal(__test.singboxCoreVersion("sing-box 1.12.4"), "1.12.4");
});

test("subscription availability follows upstream UserService semantics", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.equal(__test.nextResetAt({ plan_id: null, expired_at: 1784520000, plan_reset_traffic_method: null }, 0, 1784000000), null);
  assert.doesNotMatch(source, /Number\(user\.u \|\| 0\) \+ Number\(user\.d \|\| 0\) >= Number\(user\.transfer_enable\)/);
  assert.match(source, /Number\(user\.transfer_enable \|\| 0\) <= 0/);
});

test("Surge template subscription domain preserves a non-standard port", () => {
  const output = __test.textTemplateProfile("surge", "$subs_domain", {}, {}, [], new Request("https://panel.example:8443/s/token", { headers: { host: "panel.example:8443" } }), "token");
  assert.equal(output, "panel.example:8443");
});

test("subscription filters and hostname remain part of each freshly generated response", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /searchParams\.get\("types"\)/);
  assert.match(source, /searchParams\.get\("filter"\)/);
  assert.match(source, /subscriptionUrl\(request, config, token/);
  assert.doesNotMatch(source, /subscribe:v\d|templatesVersion|serversVersion|userVersion/);
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
  assert.equal(__test.clientOf(new Request("https://sub.example/s/token?flag=quantumult%2520x")), "quantumultx");
  assert.equal(__test.clientOf(new Request("https://sub.example/s/token", { headers: { "user-agent": "mihomo/1.19" } })), "clashmeta");
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
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /user\.expired_at !== null/);
  assert.match(source, /Number\(user\.transfer_enable \|\| 0\) <= 0/);
  assert.match(source, /groups\.includes\(Number\(user\.group_id/);
  const selected = __test.randomizedPort("2000-1000");
  assert.ok(selected.port >= 1000 && selected.port <= 2000);
  assert.equal(selected.ports, "2000-1000");
  const uuid = "00000000-0000-4000-8000-000000000000";
  const password = __test.serverPassword({ type: "shadowsocks", created_at: 1700000000, protocol_settings: { cipher: "2022-blake3-aes-128-gcm" } }, { uuid }, new Map());
  const standardDigest = createHash("md5").update("1700000000").digest("hex");
  const expected = `${Buffer.from(standardDigest.slice(0, 16)).toString("base64")}:${Buffer.from(uuid.slice(0, 16)).toString("base64")}`;
  assert.equal(__test.md5("1700000000"), standardDigest);
  assert.equal(password, expected);
});

test("QuantumultX and Loon use their official line formats", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const server = { type: "shadowsocks", name: "Node", host: "127.0.0.1", port: 8388, password: "node-password", protocol_settings: { cipher: "aes-128-gcm" } };
  assert.match(__test.quantumultXLine(user, server), /^shadowsocks=127\.0\.0\.1:8388,method=aes-128-gcm,password=node-password,/);
  assert.match(__test.loonLine(user, server), /^Node=Shadowsocks,127\.0\.0\.1,8388,aes-128-gcm,node-password,/);
});

test("audited client-specific transports match upstream renderers", () => {
  const user = { uuid: "uuid" };
  const trojanH2 = { type: "trojan", name: "Trojan H2", host: "node.example", port: 443, protocol_settings: { network: "h2", network_settings: { path: "/h2", host: ["cdn.example"] }, tls_settings: {} } };
  const shadowrocket = __test.shadowrocketLine(user, trojanH2);
  assert.match(shadowrocket, /obfs=h2/);
  assert.match(shadowrocket, /path=%2Fh2/);
  assert.match(shadowrocket, /obfsParam=cdn\.example/);

  const realityTrojan = { type: "trojan", name: "Reality", host: "node.example", port: 443, protocol_settings: { tls: 2, reality_settings: { server_name: "sni.example", public_key: "key", short_id: "id" } } };
  assert.match(__test.quantumultXLine(user, realityTrojan), /tls-host=sni\.example/);
  assert.doesNotMatch(__test.quantumultXLine(user, realityTrojan), /obfs-host=sni\.example/);

  const anytls = __test.singboxOutbound(user, { type: "anytls", name: "AnyTLS", host: "node.example", port: 443, protocol_settings: { tls: {} } });
  assert.deepEqual(anytls.tls.alpn, ["h3"]);
});

test("legacy Clash excludes Meta-only fields", () => {
  const server = { type: "vmess", name: "VMess", host: "node.example", port: 443, protocol_settings: { tls: 1, utls: { enabled: true, fingerprint: "chrome" }, tls_settings: { ech: { enabled: true, config: "ech" } }, multiplex: { enabled: true } } };
  const classic = __test.clashProxy({ uuid: "uuid" }, server, "clash");
  assert.equal(classic["client-fingerprint"], undefined);
  assert.equal(classic.smux, undefined);
  assert.equal(classic["ech-opts"], undefined);
  const meta = __test.clashProxy({ uuid: "uuid" }, server, "clashmeta");
  assert.equal(meta["client-fingerprint"], "chrome");
  assert.equal(meta.smux.enabled, true);
  assert.equal(meta["ech-opts"].enable, true);
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

test("client feature filters and protocol-specific allowlists match upstream", () => {
  const request = new Request("https://sub.example/s/token", { headers: { "user-agent": "stash/3.0.0" } });
  const servers = [
    { type: "trojan", name: "Reality", protocol_settings: { tls: 2, network: "tcp" } },
    { type: "vmess", name: "Upgrade", protocol_settings: { network: "httpupgrade" } },
    { type: "vless", name: "VLESS", protocol_settings: { tls: 2, network: "ws" } }
  ];
  assert.deepEqual(__test.filterByClientCompatibility("stash", request, servers), []);
  assert.equal(__test.versionAtLeast("1.19.9", "1.19.9"), true);
  assert.equal(__test.versionAtLeast("1.19.8", "1.19.9"), false);
  assert.ok(__test.regexValue("~(HK|香港)~i") instanceof RegExp);

  const user = { uuid: "uuid", u: 0, d: 0, transfer_enable: 1 };
  const ss2022 = [{ type: "shadowsocks", name: "SS2022", host: "example.com", port: 443, protocol_settings: { cipher: "2022-blake3-aes-256-gcm" } }];
  const clash = __test.output("clash", {}, { clash: "proxies: []\nproxy-groups: []\nrules: []\n" }, user, ss2022, new Request("https://sub.example/s/token?flag=clash"), "token");
  assert.doesNotMatch(clash, /SS2022/);
  const singbox = __test.filterByClientCompatibility("singbox", new Request("https://sub.example/s/token?flag=sing-box/1.12.0"), [{ type: "vless", protocol_settings: { network: "xhttp" } }]);
  assert.equal(singbox.length, 0);
});

test("invalid type filters behave like upstream and do not hide all nodes", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /filter\(value => validServerTypes\.has\(value\)\)/);
  assert.match(source, /requestedTypes\.length && !requestedTypes\.includes\(server\.type\)/);
});

test("subscription generation reads D1 directly without payload or settings caches", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  const db = fs.readFileSync("src/subscription/db.ts", "utf8");
  assert.match(source, /const result = await build\(request, env, token, configured\)/);
  assert.doesNotMatch(source, /cached\(|optionalKvVersion|subscribe:v\d/);
  assert.doesNotMatch(db, /settingsCache|settingsPromise|settings:snapshot|\.get\("settings_version"\)/);
  assert.equal(fs.existsSync("src/subscription/kv.ts"), false);
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
  assert.match(rendered, /https:\/\/worker\.example\/custom-sub\/token/);
  assert.match(rendered, /Node A = ss/);
  assert.doesNotMatch(rendered, /\$(app_name|subs_link|proxies|proxy_group|subscribe_info)/);
});

test("subscription URL patterns, compatibility filters and revalidation follow upstream", () => {
  assert.match(__test.replaceByPattern("https://sub[1-3].example/[uuid]"), /^https:\/\/sub[1-3]\.example\/[0-9a-f-]{36}$/);
  const configured = __test.subscriptionUrl(new Request("https://worker.example/s/token"), { subscribe_url: "https://one.example,https://two.example", subscribe_path: "s" }, "token");
  assert.match(configured, /^https:\/\/(one|two)\.example\/s\/token$/);
  const user = { uuid: "uuid", u: 0, d: 0, transfer_enable: 1 };
  const unsupported = [{ type: "vmess", name: "Upgrade", host: "example.com", port: 443, protocol_settings: { network: "httpupgrade" } }];
  assert.doesNotMatch(__test.output("clash", {}, { clash: "proxies: []\nproxy-groups: []\nrules: []\n" }, user, unsupported, new Request("https://sub.example/s/token"), "token"), /Upgrade/);
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /cache-control", "no-store, no-cache, must-revalidate"/);
  assert.match(source, /if-none-match/);
  assert.match(source, /status: 304/);
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

test("General VLESS URI uses RFC 3986 encoding for the node name", () => {
  const uri = __test.generalUri(
    { uuid: "00000000-0000-4000-8000-000000000000" },
    { type: "vless", name: "US 2 + ~!*()", host: "node.example.com", port: 443, protocol_settings: { tls: 0 } }
  );
  assert.match(uri, /#US%202%20%2B%20~%21%2A%28%29$/);
  assert.doesNotMatch(uri, /#US\+2/);
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

test("Shadowrocket Hysteria uses the upstream peer parameter", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const server = { type: "hysteria", name: "Hy2", host: "hy.example.com", port: 443, password: "secret", protocol_settings: { version: 2, tls: { server_name: "sni.example.com", allow_insecure: true }, obfs: { open: true, type: "salamander", password: "obfs-secret" } } };
  const line = __test.shadowrocketLine(user, server);
  assert.match(line, /peer=sni\.example\.com/);
  assert.doesNotMatch(line, /[?&]sni=/);
  assert.match(line, /obfs=salamander/);
  assert.match(line, /obfs-password=obfs-secret/);
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
  ] }), user, servers, "sing-box/1.13.0"));
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
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  assert.match(source, /flag\.includes\("quantumultx"\)/);
  assert.match(source, /quantumult%20x/);
  assert.match(source, /SELECT name, COALESCE\(content, ''\) AS content FROM v2_subscribe_templates/);
  assert.doesNotMatch(source, /v2_subscribe_templates WHERE enabled = 1/);
});

test("client-specific AnyTLS and Mieru output matches upstream", () => {
  const oldShadowrocket = new Request("https://sub.example/s/token", { headers: { "user-agent": "shadowrocket/1000" } });
  assert.equal(__test.filterByClientCompatibility("shadowrocket", oldShadowrocket, [{ type: "anytls", protocol_settings: {} }]).length, 0);
  const surfboard = __test.proxyLine({ uuid: "u" }, { type: "anytls", name: "A", host: "h", port: 443, protocol_settings: { tls: {} } }, "surfboard");
  assert.match(surfboard, /tfo=true/);
  assert.match(surfboard, /udp-relay=true/);
  const mieru = __test.clashProxy({ uuid: "u" }, { type: "mieru", name: "M", host: "h", port: 443, ports: "4000-5000", protocol_settings: { transport: "tcp" } }, "clashmeta");
  assert.equal(mieru.transport, "TCP");
  assert.equal(mieru["port-range"], "4000-5000");
  assert.match(__test.responseHeaders("plain", {}, { u: 0, d: 0, transfer_enable: 0, expired_at: null })["subscription-userinfo"], /expire=$/);
});

test("Clash-family Hysteria, TUIC and network allowlists follow upstream clients", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const hysteria1 = { type: "hysteria", name: "Hy1", host: "hy.example.com", port: 443, password: "secret", ports: "2000-3000", protocol_settings: { version: 1, hop_interval: 15, bandwidth: { up: 100, down: 200 }, tls: { server_name: "hy.example.com" }, obfs: { open: true, password: "obfs" } } };
  const clashHy = __test.clashProxy(user, hysteria1, "clashmeta");
  assert.equal(clashHy["hop-interval"], 15);
  assert.equal(clashHy.protocol, "udp");
  assert.equal(clashHy["fast-open"], true);
  assert.equal(clashHy.disable_mtu_discovery, true);
  const stashHy = __test.clashProxy(user, { ...hysteria1, protocol_settings: { ...hysteria1.protocol_settings, version: 2 } }, "stash");
  assert.equal(stashHy.auth, "secret");
  assert.equal(stashHy.password, undefined);
  const stashTuic = __test.clashProxy(user, { type: "tuic", name: "TUIC", host: "tuic.example.com", port: 443, password: "secret", protocol_settings: { version: 5, tls: {} } }, "stash");
  assert.deepEqual(stashTuic.alpn, ["h3"]);
  assert.equal(stashTuic["heartbeat-interval"], 10000);
  assert.equal(stashTuic["max-udp-relay-packet-size"], 1500);

  const vmessXhttp = { type: "vmess", name: "VMess XHTTP", host: "node.example.com", port: 443, protocol_settings: { network: "xhttp", network_settings: {} } };
  const rendered = __test.output("clashmeta", {}, { clashmeta: "{}" }, { ...user, u: 0, d: 0, transfer_enable: 1 }, [vmessXhttp], new Request("https://sub.example/s/token"), "token");
  assert.doesNotMatch(rendered, /VMess XHTTP/);
});

test("Shadowrocket and Sing-box preserve upstream transport defaults", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const vlessKcp = { type: "vless", name: "VLESS KCP", host: "node.example.com", port: 443, protocol_settings: { flow: "xtls-rprx-vision", network: "kcp", network_settings: { seed: "seed-value", header: { type: "srtp" } } } };
  const line = __test.shadowrocketLine(user, vlessKcp);
  assert.match(line, /tls=1/);
  assert.match(line, /obfs=kcp/);
  assert.match(line, /path=seed-value/);
  assert.match(line, /type=srtp/);
  const tuic = __test.singboxOutbound(user, { type: "tuic", name: "TUIC", host: "node.example.com", port: 443, protocol_settings: { version: 5, tls: {} } });
  assert.deepEqual(tuic.tls.alpn, ["h3"]);
});

test("Shadowsocks plugins and disabled Hysteria obfs use upstream representations", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const ss = { type: "shadowsocks", name: "SS", host: "node.example.com", port: 443, protocol_settings: { cipher: "aes-128-gcm", plugin: "v2ray-plugin", plugin_opts: "mode=websocket;tls;host=cdn.example.com;path=/ws;mux" } };
  const proxy = __test.clashProxy(user, ss, "clashmeta");
  assert.equal(proxy["plugin-opts"].mode, "websocket");
  assert.equal(proxy["plugin-opts"].tls, true);
  assert.deepEqual(proxy["plugin-opts"].headers, { Host: "cdn.example.com" });
  const uri = __test.generalUri(user, { type: "hysteria", name: "Hy2", host: "hy.example.com", port: 443, protocol_settings: { version: 2, tls: {} } });
  assert.doesNotMatch(uri, /[?&]obfs=none(?:&|#)/);
});

test("Sing-box templates adapt to the requesting core version", () => {
  const modern = __test.adaptSingboxConfig({ outbounds: [{ type: "block", tag: "block" }], route: { rules: [{ outbound: "block" }] } }, "sing-box 1.13.0");
  assert.deepEqual(modern.outbounds, []);
  assert.equal(modern.route.rules[0].action, "reject");
  const legacy = __test.adaptSingboxConfig({
    outbounds: [],
    route: { rules: [{ action: "hijack-dns" }, { action: "reject" }] },
    dns: { servers: [{ type: "https", server: "dns.example.com" }] },
    inbounds: [{ type: "tun", address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], sniff: true }]
  }, "sing-box 1.9.0");
  assert.equal(legacy.route.rules[0].outbound, "dns-out");
  assert.equal(legacy.route.rules[1].outbound, "block");
  assert.equal(legacy.dns.servers[0].address, "https://dns.example.com/dns-query");
  assert.equal(legacy.inbounds[0].inet4_address, "172.19.0.1/30");
  assert.equal(legacy.inbounds[0].inet6_address, "fdfe:dcba:9876::1/126");
  assert.equal(legacy.inbounds[0].endpoint_independent_nat, true);
});

test("Sing-box Hysteria port hopping fields require core 1.11 or newer", () => {
  const oldCore = __test.adaptSingboxConfig({ outbounds: [{ type: "hysteria2", server_ports: ["2000:3000"], hop_interval: "15s" }], route: { rules: [] } }, "sing-box 1.10.7");
  assert.equal(oldCore.outbounds[0].server_ports, undefined);
  assert.equal(oldCore.outbounds[0].hop_interval, undefined);
  const newCore = __test.adaptSingboxConfig({ outbounds: [{ type: "hysteria2", server_ports: ["2000:3000"], hop_interval: "15s" }], route: { rules: [] } }, "sing-box 1.11.0");
  assert.deepEqual(newCore.outbounds[0].server_ports, ["2000:3000"]);
  assert.equal(newCore.outbounds[0].hop_interval, "15s");
});

test("Loon preserves upstream VMess and Trojan transport fields", () => {
  const user = { uuid: "00000000-0000-4000-8000-000000000000" };
  const vmessTcp = __test.loonLine(user, { type: "vmess", name: "VMess HTTP", host: "node.example.com", port: 443, protocol_settings: { network: "tcp", network_settings: { header: { type: "http", request: { path: ["/request"], headers: { Host: ["cdn.example.com"] } } } } } });
  assert.match(vmessTcp, /transport=http/);
  assert.match(vmessTcp, /path=\/request/);
  assert.match(vmessTcp, /host=cdn\.example\.com/);
  const vmessUpgrade = __test.loonLine(user, { type: "vmess", name: "VMess Upgrade", host: "node.example.com", port: 443, protocol_settings: { network: "httpupgrade", network_settings: { path: "/up", headers: { Host: "edge.example.com" } } } });
  assert.match(vmessUpgrade, /transport=httpupgrade/);
  assert.match(vmessUpgrade, /host=edge\.example\.com/);
  const trojanH2 = __test.loonLine(user, { type: "trojan", name: "Trojan H2", host: "node.example.com", port: 443, protocol_settings: { network: "h2", network_settings: { path: "/h2", host: ["h2.example.com"] } } });
  assert.match(trojanH2, /transport=h2/);
  assert.match(trojanH2, /path=\/h2/);
  assert.match(trojanH2, /host=h2\.example\.com/);
});

test("Shadowrocket VLESS Reality omits standard TLS-only parameters", () => {
  const line = __test.shadowrocketLine({ uuid: "00000000-0000-4000-8000-000000000000" }, realityVless);
  assert.match(line, /tls=1/);
  assert.match(line, /sni=www\.example\.com/);
  assert.match(line, /pbk=reality-public-key/);
  assert.doesNotMatch(line, /allowInsecure=/);
  assert.doesNotMatch(line, /peer=/);
});

test("subscription labels and exact traffic boundaries match upstream", () => {
  assert.equal(__test.protocolPrefix({ type: "http", protocol_settings: {} }), "");
  assert.equal(__test.traffic(1073741824), "1024 MB");
  assert.equal(__test.traffic(1073741825), "1 GB");
});

test("audited subscription protocol regressions match upstream", () => {
  const user = { uuid: "uuid" };
  const vmessH2 = __test.shadowrocketLine(user, {
    type: "vmess", name: "VMess H2", host: "node.example", port: 443,
    protocol_settings: { network: "h2", network_settings: { path: "/h2", host: ["cdn.example"] } }
  });
  assert.match(vmessH2, /peer=cdn\.example/);

  const hysteria = __test.singboxOutbound(user, {
    type: "hysteria", name: "Hy1", host: "node.example", port: 443,
    protocol_settings: { version: 1, obfs: { open: false, password: "secret" }, tls: {} }
  });
  assert.equal(hysteria.obfs, "secret");

  const trojan = __test.loonLine(user, {
    type: "trojan", name: "Trojan", host: "node.example", port: 443,
    protocol_settings: { tls: 1, tls_settings: { server_name: "sni.example" } }
  });
  assert.doesNotMatch(trojan, /over-tls=true/);

  const stashOld = new Request("https://sub.example/s/token", { headers: { "user-agent": "stash/3.2.9" } });
  assert.deepEqual(__test.filterByClientCompatibility("stash", stashOld, [{ type: "anytls", protocol_settings: {} }]), []);
  const singboxOld = new Request("https://sub.example/s/token?flag=sing-box/1.4.0");
  assert.deepEqual(__test.filterByClientCompatibility("singbox", singboxOld, [
    { type: "tuic", protocol_settings: {} }, { type: "hysteria", protocol_settings: { version: 1 } }, { type: "anytls", protocol_settings: {} }
  ]), []);

  const shadowrocketSecure = __test.shadowrocketLine(user, {
    type: "hysteria", name: "Hy2", host: "node.example", port: 443,
    protocol_settings: { version: 2, tls: { allow_insecure: false } }
  });
  assert.match(shadowrocketSecure, /insecure=0/);
  const shadowrocketInsecure = __test.shadowrocketLine(user, {
    type: "anytls", name: "AnyTLS", host: "node.example", port: 443,
    protocol_settings: { tls: { allow_insecure: true } }
  });
  assert.match(shadowrocketInsecure, /insecure=1/);

  const generalVmess = JSON.parse(Buffer.from(__test.generalUri(user, {
    type: "vmess", name: "VMess", host: "node.example", port: 443,
    protocol_settings: {}
  }).slice("vmess://".length), "base64").toString("utf8"));
  assert.equal(generalVmess.net, null);
  const generalHysteria = __test.generalUri(user, {
    type: "hysteria", name: "Hy2", host: "node.example", port: 443,
    protocol_settings: { version: 2, tls: {}, obfs: { open: true, type: "custom", password: "secret" } }
  });
  assert.match(generalHysteria, /obfs=salamander/);
  assert.doesNotMatch(generalHysteria, /obfs=custom/);

  const stashVless = __test.clashProxy(user, {
    type: "vless", name: "VLESS", host: "node.example", port: 443,
    protocol_settings: { network: "tcp", tls: 0 }
  }, "stash");
  assert.equal(stashVless.alterId, undefined);
  assert.equal(stashVless.cipher, undefined);
  assert.equal(stashVless.encryption, undefined);

  const plainVmess = __test.clashProxy(user, { type: "vmess", name: "VMess", host: "node.example", port: 80, protocol_settings: { network: "tcp", tls: 0 } }, "clashmeta");
  assert.equal(plainVmess.tls, undefined);
  assert.equal(plainVmess["skip-cert-verify"], undefined);
  const plainHttp = __test.clashProxy(user, { type: "http", name: "HTTP", host: "node.example", port: 80, protocol_settings: {} }, "clashmeta");
  assert.equal(plainHttp.udp, undefined);

  const loonTrojanTcp = __test.loonLine(user, {
    type: "trojan", name: "Trojan TCP", host: "node.example", port: 443,
    protocol_settings: { network: "tcp", tls: 1, tls_settings: {} }
  });
  assert.doesNotMatch(loonTrojanTcp, /transport=tcp/);

  for (const type of ["hysteria", "mieru"]) {
    const proxy = __test.clashProxy(user, { type, name: type, host: "node.example", port: 443, protocol_settings: { version: 2 } }, "clashmeta");
    assert.equal(proxy.udp, undefined);
  }

  const hiddify = { outbounds: [{ type: "hysteria2", server_ports: ["1000:2000"], hop_interval: "10s" }] };
  __test.adaptSingboxConfig(hiddify, "Hiddify/2.5.7");
  assert.equal(hiddify.outbounds[0].server_ports, undefined);
  assert.equal(hiddify.outbounds[0].hop_interval, undefined);

  assert.equal(__test.responseHeaders("clash", { app_name: "XBoard" }, user)["profile-web-page-url"], "");
});

test("Sing-box TCP HTTP transport preserves the upstream empty host array", () => {
  const outbound = __test.singboxOutbound({ uuid: "user" }, {
    type: "vmess", host: "node.example", port: 443,
    protocol_settings: { network: "tcp", network_settings: { header: { type: "http", request: { path: ["/"] } } } }
  });
  assert.equal(outbound.transport.type, "http");
  assert.equal("host" in outbound.transport, true);
  assert.deepEqual(outbound.transport.host, []);
});

test("audited SOCKS, uTLS, TLS defaults and reset-day behavior match upstream", () => {
  const user = { uuid: "uuid" };
  const base = { name: "Node", host: "node.example", port: 443 };
  assert.equal(__test.clashProxy(user, { ...base, type: "socks", protocol_settings: {} }, "clashmeta").type, "socks5");

  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const randomTls = { ...base, type: "vless", protocol_settings: { tls: 1, utls: { enabled: true, fingerprint: "random" }, tls_settings: {}, network: "tcp" } };
    assert.equal(__test.clashProxy(user, randomTls, "clashmeta")["client-fingerprint"], "ios");
    assert.equal(__test.singboxOutbound(user, randomTls).tls.utls.fingerprint, "ios");
  } finally {
    Math.random = originalRandom;
  }

  const noTlsVmess = __test.clashProxy(user, { ...base, type: "vmess", protocol_settings: { tls: 0 } }, "stash");
  assert.equal(noTlsVmess.tls, false);
  assert.equal(noTlsVmess["skip-cert-verify"], false);
  const noTlsVless = __test.clashProxy(user, { ...base, type: "vless", protocol_settings: { tls: 0 } }, "clashmeta");
  assert.equal(noTlsVless.tls, false);

  const from = Date.UTC(2026, 6, 15, 4, 0) / 1000;
  const expiry = Date.UTC(2026, 7, 20, 4, 0) / 1000;
  assert.equal(__test.nextResetAt({ plan_id: 1, expired_at: expiry, plan_reset_traffic_method: 1 }, 0, from), Date.UTC(2026, 6, 20, 4, 0) / 1000);
  assert.equal(__test.nextResetAt({ plan_id: 1, expired_at: expiry, plan_reset_traffic_method: null }, 0, from), Date.UTC(2026, 6, 31, 16, 0) / 1000);
});

test("General VMess HTTP randomizes configured path and host like upstream", () => {
  const originalRandom = Math.random;
  const values = [0.99, 0.99, 0.99];
  Math.random = () => values.shift() ?? 0;
  try {
    const uri = __test.generalUri({ uuid: "uuid" }, {
      type: "vmess", name: "Random HTTP", host: "node.example", port: 80,
      protocol_settings: { network: "tcp", network_settings: { header: { type: "http", request: { path: ["/a", "/b"], headers: { Host: ["h1", "h2"] } } } } }
    });
    const config = JSON.parse(Buffer.from(uri.slice("vmess://".length), "base64").toString("utf8"));
    assert.equal(config.path, "/b");
    assert.equal(config.host, "h2");
  } finally {
    Math.random = originalRandom;
  }
});

test("Stash transport and Trojan Reality fields match protocol-specific upstream support", () => {
  const user = { uuid: "uuid" };
  const reality = __test.clashProxy(user, {
    type: "trojan", name: "Reality", host: "node.example", port: 443,
    protocol_settings: { tls: 2, network: "tcp", reality_settings: { server_name: "sni.example", public_key: "pk", short_id: "sid" } }
  }, "stash");
  assert.equal(reality.tls, true);

  const vmessH2 = __test.clashProxy(user, { type: "vmess", name: "VMess H2", host: "node.example", port: 443, protocol_settings: { network: "h2", network_settings: { path: "/h2", host: "cdn.example" } } }, "stash");
  assert.equal(vmessH2.network, "h2");
  assert.equal(vmessH2.tls, true);
  assert.equal(vmessH2["h2-opts"].path, "/h2");

  const vlessXhttp = __test.clashProxy(user, { type: "vless", name: "VLESS XHTTP", host: "node.example", port: 443, protocol_settings: { network: "xhttp", network_settings: { path: "/x" } } }, "stash");
  assert.equal(vlessXhttp.network, "tcp");
  assert.equal(vlessXhttp["xhttp-opts"], undefined);

  const trojanH2 = __test.clashProxy(user, { type: "trojan", name: "Trojan H2", host: "node.example", port: 443, protocol_settings: { network: "h2", tls_settings: {}, network_settings: { path: "/h2" } } }, "stash");
  assert.equal(trojanH2.network, "tcp");
  assert.equal(trojanH2["h2-opts"], undefined);
});

test("QuantumultX transport host overrides TLS SNI without duplicate host keys", () => {
  const line = __test.quantumultXLine({ uuid: "uuid" }, {
    type: "vmess", name: "VMess WS", host: "node.example", port: 443,
    protocol_settings: {
      network: "ws", tls: 1,
      network_settings: { path: "/ws", headers: { Host: "edge.example" } },
      tls_settings: { server_name: "sni.example", allow_insecure: false }
    }
  });
  assert.equal((line.match(/obfs-host=/g) || []).length, 1);
  assert.match(line, /obfs-host=edge\.example/);
  assert.doesNotMatch(line, /obfs-host=sni\.example/);

  const trojan = __test.quantumultXLine({ uuid: "uuid" }, {
    type: "trojan", name: "Trojan WS", host: "node.example", port: 443,
    protocol_settings: {
      network: "ws", tls: 1,
      network_settings: { path: "/ws", headers: { Host: "edge.example" } },
      tls_settings: { server_name: "sni.example", allow_insecure: false }
    }
  });
  assert.match(trojan, /obfs-host=edge\.example/);
  assert.doesNotMatch(trojan, /tls-host=/);
});

test("subscription banners preserve upstream overdraft and Asia Shanghai expiry", () => {
  const expiredAt = Date.UTC(2026, 6, 15, 16, 30, 0) / 1000;
  const user = { uuid: "uuid", u: 6 * 1073741824, d: 4 * 1073741824, transfer_enable: 8 * 1073741824, expired_at: expiredAt };
  const banner = __test.textTemplateProfile("surge", "$subscribe_info", { app_name: "XBoard" }, user, [], new Request("https://sub.example/s/token"), "token");
  assert.match(banner, /剩余流量：-2GB/);
  assert.match(banner, /到期时间：2026-07-16 00:30:00/);
  const shadowrocket = Buffer.from(__test.output("shadowrocket", {}, {}, user, [], new Request("https://sub.example/s/token"), "token"), "base64").toString("utf8");
  assert.match(shadowrocket, /Expires:2026-07-16/);
});

test("subscription validation and generation use a first-unconstrained D1 session", () => {
  const source = fs.readFileSync("src/subscription/index.ts", "utf8");
  const db = fs.readFileSync("src/subscription/db.ts", "utf8");
  assert.match(db, /db\.withSession\("first-unconstrained"\)/);
  assert.match(source, /XBOARD_DB: replicaDatabase\(env\.SUBSCRIPTION_DB \|\| env\.XBOARD_DB\)/);
  assert.doesNotMatch(db, /db\.withSession\("first-primary"\)/);
});

test("ClashX Meta, legacy Clash plugins and TCP HTTP choices follow upstream", () => {
  const oldClashX = new Request("https://sub.example/s/token", { headers: { "user-agent": "ClashX Meta/1.3.4" } });
  const newClashX = new Request("https://sub.example/s/token", { headers: { "user-agent": "ClashX Meta/1.3.5" } });
  const hysteria = [{ type: "hysteria", protocol_settings: { version: 2 } }];
  assert.equal(__test.filterByClientCompatibility("clashmeta", oldClashX, hysteria).length, 0);
  assert.equal(__test.filterByClientCompatibility("clashmeta", newClashX, hysteria).length, 1);
  const legacy = __test.clashProxy({ uuid: "u" }, { type: "shadowsocks", name: "S", host: "h", port: 1, protocol_settings: { cipher: "aes-128-gcm", plugin: "obfs-local", plugin_opts: "obfs=http" } }, "clash");
  assert.equal(legacy.plugin, "obfs-local");
});

test("missing uTLS configuration receives the upstream random fingerprint", () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const proxy = __test.clashProxy({ uuid: "u" }, {
      type: "vless", name: "V", host: "h", port: 443,
      protocol_settings: { tls: 1, tls_settings: { server_name: "h" }, network: "tcp" }
    }, "clashmeta");
    assert.equal(proxy["client-fingerprint"], "chrome");
  } finally {
    Math.random = originalRandom;
  }
});
