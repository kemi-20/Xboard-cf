INSERT OR IGNORE INTO v2_settings(name, value, created_at, updated_at) VALUES
('app_name', 'XBoard CF', unixepoch(), unixepoch()),
('app_url', '', unixepoch(), unixepoch()),
('subscribe_path', 's', unixepoch(), unixepoch()),
('frontend_admin_path', 'admin', unixepoch(), unixepoch()),
('secure_path', 'admin', unixepoch(), unixepoch()),
('server_ws_enable', '1', unixepoch(), unixepoch()),
('payment_enabled', '0', unixepoch(), unixepoch());

INSERT OR IGNORE INTO v2_user(email, password, password_algo, password_salt, uuid, token, transfer_enable, is_admin, is_staff, created_at, updated_at)
VALUES ('admin@admin.com', 'pbkdf2$sha256$100000$xboard-cloudflare-admin$8d8b20ea4c5f0851f5f468f5e5b907ae67061c3337dbc738fcbcd83f4388d96d', 'pbkdf2', 'xboard-cloudflare-admin', '00000000-0000-4000-8000-000000000001', 'admin-default-token-change-me', 1099511627776, 1, 1, unixepoch(), unixepoch());

INSERT OR IGNORE INTO v2_server_group(id, name, created_at, updated_at) VALUES (1, 'Default', unixepoch(), unixepoch());
