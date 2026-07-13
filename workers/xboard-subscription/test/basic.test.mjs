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
