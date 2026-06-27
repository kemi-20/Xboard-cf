PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS v2_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_user_id INTEGER DEFAULT NULL,
  telegram_id INTEGER DEFAULT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  password_algo TEXT NOT NULL DEFAULT 'pbkdf2',
  password_salt TEXT DEFAULT NULL,
  uuid TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  remarks TEXT DEFAULT NULL,
  transfer_enable INTEGER NOT NULL DEFAULT 0,
  u INTEGER NOT NULL DEFAULT 0,
  d INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_staff INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER DEFAULT NULL,
  expired_at INTEGER DEFAULT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  commission_balance INTEGER NOT NULL DEFAULT 0,
  plan_id INTEGER DEFAULT NULL,
  group_id INTEGER DEFAULT NULL,
  device_limit INTEGER DEFAULT NULL,
  speed_limit INTEGER DEFAULT NULL,
  discount INTEGER DEFAULT NULL,
  commission_rate INTEGER DEFAULT NULL,
  remind_expire INTEGER NOT NULL DEFAULT 1,
  remind_traffic INTEGER NOT NULL DEFAULT 1,
  reset_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at INTEGER DEFAULT NULL,
  next_reset_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tokenable_type TEXT NOT NULL DEFAULT 'user',
  tokenable_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  abilities TEXT,
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,
  transfer_enable INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  speed_limit INTEGER,
  device_limit INTEGER,
  capacity_limit INTEGER,
  reset_traffic_method INTEGER DEFAULT 0,
  prices TEXT,
  content TEXT,
  tags TEXT,
  show INTEGER NOT NULL DEFAULT 1,
  sell INTEGER NOT NULL DEFAULT 1,
  renew INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_server_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_server_route (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  remarks TEXT,
  match TEXT,
  action TEXT,
  action_value TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_server_machine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT,
  notes TEXT,
  token TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  last_seen_at INTEGER,
  load_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_server_machine_load_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL,
  load_status TEXT,
  network TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_server (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  group_ids TEXT,
  route_ids TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  server_port INTEGER,
  rate REAL NOT NULL DEFAULT 1,
  tags TEXT,
  protocol_settings TEXT,
  custom_outbounds TEXT,
  custom_routes TEXT,
  cert_config TEXT,
  listen_address TEXT,
  rate_time_enable INTEGER DEFAULT 0,
  rate_time_ranges TEXT,
  transfer_enable INTEGER DEFAULT 0,
  excludes TEXT,
  ips TEXT,
  code TEXT,
  machine_id INTEGER,
  show INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_push_at INTEGER,
  online_user INTEGER NOT NULL DEFAULT 0,
  u INTEGER NOT NULL DEFAULT 0,
  d INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  value TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_notice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT,
  show INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  title TEXT NOT NULL,
  body TEXT,
  show INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_ticket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  reply_status INTEGER NOT NULL DEFAULT 0,
  last_reply_user_id INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_ticket_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  user_id INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_mail_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_stat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_at INTEGER NOT NULL,
  user_count INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  transfer_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_stat_user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  server_id INTEGER,
  server_type TEXT,
  u INTEGER NOT NULL DEFAULT 0,
  d INTEGER NOT NULL DEFAULT 0,
  rate REAL NOT NULL DEFAULT 1,
  record_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, server_id, server_type, record_at)
);

CREATE TABLE IF NOT EXISTS v2_stat_server (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  server_type TEXT NOT NULL,
  u INTEGER NOT NULL DEFAULT 0,
  d INTEGER NOT NULL DEFAULT 0,
  record_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id, server_type, record_at)
);

CREATE TABLE IF NOT EXISTS v2_admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_traffic_reset_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reset_type TEXT NOT NULL,
  old_u INTEGER NOT NULL DEFAULT 0,
  old_d INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  reset_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_subscribe_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'clash',
  content TEXT,
  template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  trade_no TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'disabled',
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_payment (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, payment TEXT, config TEXT, enable INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_coupon (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, type TEXT, value INTEGER DEFAULT 0, show INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_commission_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, order_id INTEGER, amount INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_gift_card_template (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, conditions TEXT, rewards TEXT, limits TEXT, special_config TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_gift_card_code (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, template_id INTEGER, status TEXT DEFAULT 'disabled', actual_rewards TEXT, metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_gift_card_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER, user_id INTEGER, rewards_given TEXT, invite_rewards TEXT, multiplier_applied REAL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS idx_v2_user_token ON v2_user(token);
CREATE INDEX IF NOT EXISTS idx_v2_user_email ON v2_user(email);
CREATE INDEX IF NOT EXISTS idx_v2_server_enabled ON v2_server(enabled, show);
CREATE INDEX IF NOT EXISTS idx_v2_stat_user_record ON v2_stat_user(record_at);
CREATE INDEX IF NOT EXISTS idx_v2_stat_server_record ON v2_stat_server(record_at);
