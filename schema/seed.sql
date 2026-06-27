INSERT INTO v2_settings(name, value, created_at, updated_at) VALUES
('app_name', 'XBoard CF', unixepoch(), unixepoch()),
('app_description', 'XBoard Cloudflare-native panel', unixepoch(), unixepoch()),
('app_url', '', unixepoch(), unixepoch()),
('logo', '', unixepoch(), unixepoch()),
('subscribe_url', '', unixepoch(), unixepoch()),
('subscribe_path', 's', unixepoch(), unixepoch()),
('frontend_admin_path', 'admin', unixepoch(), unixepoch()),
('secure_path', 'admin', unixepoch(), unixepoch()),
('frontend_theme', 'Xboard', unixepoch(), unixepoch()),
('frontend_theme_sidebar', 'light', unixepoch(), unixepoch()),
('frontend_theme_header', 'dark', unixepoch(), unixepoch()),
('frontend_theme_color', 'default', unixepoch(), unixepoch()),
('currency', 'CNY', unixepoch(), unixepoch()),
('currency_symbol', '¥', unixepoch(), unixepoch()),
('try_out_plan_id', '1', unixepoch(), unixepoch()),
('try_out_hour', '24', unixepoch(), unixepoch()),
('plan_change_enable', '1', unixepoch(), unixepoch()),
('reset_traffic_method', '0', unixepoch(), unixepoch()),
('surplus_enable', '1', unixepoch(), unixepoch()),
('default_remind_expire', '1', unixepoch(), unixepoch()),
('default_remind_traffic', '1', unixepoch(), unixepoch()),
('server_token', 'xboard-cf-server-token-change-me', unixepoch(), unixepoch()),
('server_pull_interval', '60', unixepoch(), unixepoch()),
('server_push_interval', '60', unixepoch(), unixepoch()),
('server_ws_enable', '1', unixepoch(), unixepoch()),
('server_ws_url', '', unixepoch(), unixepoch()),
('device_limit_mode', '0', unixepoch(), unixepoch()),
('payment_enabled', '0', unixepoch(), unixepoch()),
('invite_force', '0', unixepoch(), unixepoch()),
('invite_commission', '10', unixepoch(), unixepoch()),
('invite_gen_limit', '5', unixepoch(), unixepoch()),
('invite_never_expire', '0', unixepoch(), unixepoch()),
('commission_first_time_enable', '1', unixepoch(), unixepoch()),
('commission_auto_check_enable', '1', unixepoch(), unixepoch()),
('commission_withdraw_limit', '100', unixepoch(), unixepoch()),
('commission_withdraw_method', '["USDT","支付宝"]', unixepoch(), unixepoch()),
('email_verify', '0', unixepoch(), unixepoch()),
('safe_mode_enable', '0', unixepoch(), unixepoch()),
('email_whitelist_enable', '0', unixepoch(), unixepoch()),
('email_whitelist_suffix', '["gmail.com","qq.com","163.com"]', unixepoch(), unixepoch()),
('email_gmail_limit_enable', '0', unixepoch(), unixepoch()),
('captcha_enable', '0', unixepoch(), unixepoch()),
('captcha_type', 'recaptcha', unixepoch(), unixepoch()),
('recaptcha_key', '', unixepoch(), unixepoch()),
('recaptcha_site_key', '', unixepoch(), unixepoch()),
('recaptcha_v3_secret_key', '', unixepoch(), unixepoch()),
('recaptcha_v3_site_key', '', unixepoch(), unixepoch()),
('recaptcha_v3_score_threshold', '0.5', unixepoch(), unixepoch()),
('turnstile_secret_key', '', unixepoch(), unixepoch()),
('turnstile_site_key', '', unixepoch(), unixepoch()),
('register_limit_by_ip_enable', '0', unixepoch(), unixepoch()),
('register_limit_count', '3', unixepoch(), unixepoch()),
('register_limit_expire', '60', unixepoch(), unixepoch()),
('password_limit_enable', '1', unixepoch(), unixepoch()),
('password_limit_count', '5', unixepoch(), unixepoch()),
('password_limit_expire', '60', unixepoch(), unixepoch()),
('email_host', '', unixepoch(), unixepoch()),
('email_port', '', unixepoch(), unixepoch()),
('email_username', '', unixepoch(), unixepoch()),
('email_password', '', unixepoch(), unixepoch()),
('email_encryption', '', unixepoch(), unixepoch()),
('email_from_address', '', unixepoch(), unixepoch()),
('remind_mail_enable', '0', unixepoch(), unixepoch()),
('telegram_bot_enable', '0', unixepoch(), unixepoch()),
('telegram_bot_token', '', unixepoch(), unixepoch()),
('telegram_webhook_url', '', unixepoch(), unixepoch()),
('telegram_discuss_link', '', unixepoch(), unixepoch()),
('windows_version', '', unixepoch(), unixepoch()),
('windows_download_url', '', unixepoch(), unixepoch()),
('macos_version', '', unixepoch(), unixepoch()),
('macos_download_url', '', unixepoch(), unixepoch()),
('android_version', '', unixepoch(), unixepoch()),
('android_download_url', '', unixepoch(), unixepoch())
ON CONFLICT(name) DO UPDATE SET
  value = CASE WHEN v2_settings.value IS NULL OR v2_settings.value = '' THEN excluded.value ELSE v2_settings.value END,
  updated_at = unixepoch();

INSERT INTO v2_server_group(id, name, created_at, updated_at) VALUES
(1, 'Default', unixepoch(), unixepoch())
ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = unixepoch();

INSERT INTO v2_plan(id, group_id, transfer_enable, name, speed_limit, device_limit, capacity_limit, reset_traffic_method, prices, content, tags, show, sell, renew, sort, created_at, updated_at) VALUES
(1, 1, 1099511627776, 'Default Trial', NULL, NULL, NULL, 0, '{"monthly":0}', 'Default seeded plan for first-run compatibility.', '[]', 1, 1, 1, 1, unixepoch(), unixepoch())
ON CONFLICT(id) DO UPDATE SET
  group_id = excluded.group_id,
  transfer_enable = excluded.transfer_enable,
  name = excluded.name,
  show = excluded.show,
  sell = excluded.sell,
  renew = excluded.renew,
  updated_at = unixepoch();

INSERT INTO v2_user(email, password, password_algo, password_salt, uuid, token, transfer_enable, u, d, is_admin, is_staff, plan_id, group_id, remind_expire, remind_traffic, created_at, updated_at)
VALUES ('admin@admin.com', 'pbkdf2$sha256$100000$xboard-cloudflare-admin$8abd89496c7d7b0cfdc7b786fd49da099859e1167bbcf9f945c38415d6d56268', 'pbkdf2', 'xboard-cloudflare-admin', '00000000-0000-4000-8000-000000000001', 'admin-default-token-change-me', 1099511627776, 0, 0, 1, 1, 1, 1, 1, 1, unixepoch(), unixepoch())
ON CONFLICT(email) DO UPDATE SET
  password = excluded.password,
  password_algo = excluded.password_algo,
  password_salt = excluded.password_salt,
  transfer_enable = excluded.transfer_enable,
  is_admin = 1,
  is_staff = 1,
  plan_id = COALESCE(v2_user.plan_id, excluded.plan_id),
  group_id = COALESCE(v2_user.group_id, excluded.group_id),
  remind_expire = 1,
  remind_traffic = 1,
  updated_at = unixepoch();

INSERT INTO v2_notice(id, title, content, show, sort, created_at, updated_at) VALUES
(1, 'Welcome to XBoard CF', 'The Cloudflare-native XBoard panel is ready.', 1, 1, unixepoch(), unixepoch())
ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, show = excluded.show, updated_at = unixepoch();

INSERT INTO v2_knowledge(id, category, title, body, show, sort, created_at, updated_at) VALUES
(1, 'Getting Started', 'First-run checklist', 'Update the default administrator password, configure app_url, and add real nodes before production use.', 1, 1, unixepoch(), unixepoch())
ON CONFLICT(id) DO UPDATE SET category = excluded.category, title = excluded.title, body = excluded.body, show = excluded.show, updated_at = unixepoch();

INSERT INTO v2_mail_templates(name, subject, content, enabled, created_at, updated_at) VALUES
('notify', 'Notification from {{app.name}}', '{{content}}', 1, unixepoch(), unixepoch()),
('verify', 'Email verification code', 'Your verification code is {{code}}.', 1, unixepoch(), unixepoch()),
('remind_expire', 'Service expiry reminder', 'Your service is about to expire.', 1, unixepoch(), unixepoch()),
('remind_traffic', 'Traffic usage reminder', 'Your traffic usage is high.', 1, unixepoch(), unixepoch())
ON CONFLICT(name) DO UPDATE SET
  subject = excluded.subject,
  content = excluded.content,
  enabled = excluded.enabled,
  updated_at = unixepoch();

INSERT INTO v2_subscribe_templates(name, type, content, template, enabled, created_at, updated_at) VALUES
('singbox', 'singbox', '{
  "dns": {"servers": [{"tag": "remote", "address": "https://1.1.1.1/dns-query"}, {"tag": "local", "address": "https://223.5.5.5/dns-query"}]},
  "inbounds": [{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2334, "sniff": true}],
  "outbounds": [{"type": "selector", "tag": "节点选择", "outbounds": ["自动选择"]}, {"type": "urltest", "tag": "自动选择", "outbounds": []}, {"type": "direct", "tag": "direct"}, {"type": "block", "tag": "block"}],
  "route": {"rules": [{"ip_is_private": true, "outbound": "direct"}]}
}', '{
  "dns": {"servers": [{"tag": "remote", "address": "https://1.1.1.1/dns-query"}, {"tag": "local", "address": "https://223.5.5.5/dns-query"}]},
  "inbounds": [{"type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2334, "sniff": true}],
  "outbounds": [{"type": "selector", "tag": "节点选择", "outbounds": ["自动选择"]}, {"type": "urltest", "tag": "自动选择", "outbounds": []}, {"type": "direct", "tag": "direct"}, {"type": "block", "tag": "block"}],
  "route": {"rules": [{"ip_is_private": true, "outbound": "direct"}]}
}', 1, unixepoch(), unixepoch()),
('clash', 'clash', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 1, unixepoch(), unixepoch()),
('clashmeta', 'clashmeta', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "故障转移", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
  - { name: "故障转移", type: fallback, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
unified-delay: true
tcp-concurrent: true
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "故障转移", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
  - { name: "故障转移", type: fallback, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 1, unixepoch(), unixepoch()),
('stash', 'stash', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 'mixed-port: 7890
allow-lan: true
mode: rule
log-level: info
proxies:
proxy-groups:
  - { name: "$app_name", type: select, proxies: ["自动选择", "DIRECT"] }
  - { name: "自动选择", type: url-test, proxies: [], url: "http://www.gstatic.com/generate_204", interval: 300 }
rules:
  - GEOIP,CN,DIRECT
  - MATCH,$app_name
', 1, unixepoch(), unixepoch()),
('surge', 'surge', '#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.5.5.5, 114.114.114.114
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy,dns-failed
', '#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.5.5.5, 114.114.114.114
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy,dns-failed
', 1, unixepoch(), unixepoch()),
('surfboard', 'surfboard', '#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.6.6.6, 119.29.29.29
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy
', '#!MANAGED-CONFIG $subs_link interval=43200 strict=true
[General]
loglevel = notify
dns-server = 223.6.6.6, 119.29.29.29
[Panel]
SubscribeInfo = $subscribe_info, style=info
[Proxy]
$proxies
[Proxy Group]
Proxy = select, auto, fallback, $proxy_group
[Rule]
DOMAIN,$subs_domain,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy
', 1, unixepoch(), unixepoch())
ON CONFLICT(name) DO UPDATE SET
  content = CASE WHEN v2_subscribe_templates.content IS NULL OR v2_subscribe_templates.content = '' THEN excluded.content ELSE v2_subscribe_templates.content END,
  template = CASE WHEN v2_subscribe_templates.template IS NULL OR v2_subscribe_templates.template = '' THEN excluded.template ELSE v2_subscribe_templates.template END,
  enabled = 1,
  updated_at = unixepoch();
