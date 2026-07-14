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
  commission_type INTEGER NOT NULL DEFAULT 0,
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
  cpu REAL NOT NULL DEFAULT 0,
  mem_total INTEGER NOT NULL DEFAULT 0,
  mem_used INTEGER NOT NULL DEFAULT 0,
  disk_total INTEGER NOT NULL DEFAULT 0,
  disk_used INTEGER NOT NULL DEFAULT 0,
  net_in_speed REAL,
  net_out_speed REAL,
  recorded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_machine_load_recorded
  ON v2_server_machine_load_history(machine_id, recorded_at);

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
  metrics TEXT,
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
  img_url TEXT,
  tags TEXT,
  popup INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS v2_invite_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 0,
  pv INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  template_name TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  type TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT,
  installed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS failed_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  exception TEXT NOT NULL,
  failed_at INTEGER NOT NULL
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
  server_rate REAL NOT NULL DEFAULT 1,
  record_type TEXT NOT NULL DEFAULT 'd',
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
  plan_id INTEGER,
  payment_id INTEGER,
  period TEXT,
  trade_no TEXT UNIQUE,
  status INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  handling_amount INTEGER,
  balance_amount INTEGER,
  surplus_credit INTEGER,
  surplus_amount INTEGER,
  type INTEGER NOT NULL DEFAULT 1,
  surplus_order_ids TEXT,
  coupon_id INTEGER,
  commission_status INTEGER NOT NULL DEFAULT 0,
  invite_user_id INTEGER,
  actual_commission_balance INTEGER,
  commission_rate INTEGER,
  commission_auto_check INTEGER,
  commission_balance INTEGER,
  discount_amount INTEGER,
  paid_at INTEGER,
  callback_no TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_payment (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, payment TEXT, config TEXT, enable INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_coupon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type INTEGER NOT NULL,
  value INTEGER NOT NULL,
  show INTEGER NOT NULL DEFAULT 0,
  limit_use INTEGER,
  limit_use_with_user INTEGER,
  limit_plan_ids TEXT,
  limit_period TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_commission_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, order_id INTEGER, amount INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS v2_gift_card_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, type INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 1, conditions TEXT, rewards TEXT NOT NULL, limits TEXT, special_config TEXT,
  icon TEXT, background_image TEXT, theme_color TEXT NOT NULL DEFAULT '#1890ff', sort INTEGER NOT NULL DEFAULT 0,
  admin_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_gift_card_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, batch_id TEXT,
  status INTEGER NOT NULL DEFAULT 0, user_id INTEGER, used_at INTEGER, expires_at INTEGER, actual_rewards TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0, max_usage INTEGER NOT NULL DEFAULT 1, metadata TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_gift_card_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER NOT NULL, template_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  invite_user_id INTEGER, rewards_given TEXT NOT NULL, invite_rewards TEXT, user_level_at_use INTEGER,
  plan_id_at_use INTEGER, multiplier_applied REAL NOT NULL DEFAULT 1, ip_address TEXT, user_agent TEXT, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_template_type_status ON v2_gift_card_template(type, status);
CREATE INDEX IF NOT EXISTS idx_gift_code_template_id ON v2_gift_card_code(template_id);
CREATE INDEX IF NOT EXISTS idx_gift_code_status ON v2_gift_card_code(status);
CREATE INDEX IF NOT EXISTS idx_gift_code_batch_id ON v2_gift_card_code(batch_id);
CREATE INDEX IF NOT EXISTS idx_gift_usage_user_usage ON v2_gift_card_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gift_usage_template_stats ON v2_gift_card_usage(template_id, created_at);

CREATE INDEX IF NOT EXISTS idx_v2_user_token ON v2_user(token);
CREATE INDEX IF NOT EXISTS idx_v2_user_email ON v2_user(email);
CREATE INDEX IF NOT EXISTS idx_v2_server_enabled ON v2_server(enabled, show);
CREATE INDEX IF NOT EXISTS idx_v2_stat_user_record ON v2_stat_user(record_at);
CREATE INDEX IF NOT EXISTS idx_v2_stat_server_record ON v2_stat_server(record_at);
