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
  t INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_staff INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER DEFAULT NULL,
  last_login_ip TEXT DEFAULT NULL,
  online_count INTEGER NOT NULL DEFAULT 0,
  last_online_at INTEGER DEFAULT NULL,
  expired_at INTEGER DEFAULT 0,
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
  show INTEGER NOT NULL DEFAULT 0,
  sell INTEGER NOT NULL DEFAULT 0,
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
  port TEXT NOT NULL,
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
  show INTEGER NOT NULL DEFAULT 0,
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
  `group` TEXT,
  type TEXT,
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
  show INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT,
  language TEXT,
  title TEXT NOT NULL,
  body TEXT,
  show INTEGER NOT NULL DEFAULT 0,
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
  user_id INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS v2_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT,
  host TEXT,
  uri TEXT NOT NULL,
  method TEXT NOT NULL,
  data TEXT,
  ip TEXT,
  context TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_stat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_at INTEGER NOT NULL,
  user_count INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  transfer_used INTEGER NOT NULL DEFAULT 0,
  transfer_used_total INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  invite_count INTEGER NOT NULL DEFAULT 0,
  order_total INTEGER NOT NULL DEFAULT 0,
  paid_total INTEGER NOT NULL DEFAULT 0,
  paid_count INTEGER NOT NULL DEFAULT 0,
  commission_total INTEGER NOT NULL DEFAULT 0,
  commission_count INTEGER NOT NULL DEFAULT 0,
  record_type TEXT NOT NULL DEFAULT 'd',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(record_at, record_type)
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
  record_type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id, server_type, record_at)
);

CREATE TABLE IF NOT EXISTS v2_admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT,
  ip TEXT,
  method TEXT,
  uri TEXT,
  request_data TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS v2_traffic_reset_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  reset_type TEXT NOT NULL,
  old_u INTEGER NOT NULL DEFAULT 0,
  old_d INTEGER NOT NULL DEFAULT 0,
  old_upload INTEGER NOT NULL DEFAULT 0,
  old_download INTEGER NOT NULL DEFAULT 0,
  old_total INTEGER NOT NULL DEFAULT 0,
  new_upload INTEGER NOT NULL DEFAULT 0,
  new_download INTEGER NOT NULL DEFAULT 0,
  new_total INTEGER NOT NULL DEFAULT 0,
  trigger_source TEXT,
  metadata TEXT,
  reset_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
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
CREATE INDEX IF NOT EXISTS idx_failed_jobs_failed_at ON failed_jobs(failed_at);
CREATE INDEX IF NOT EXISTS idx_v2_job_logs_status_time ON v2_job_logs(status, updated_at, created_at);
CREATE TABLE IF NOT EXISTS v2_traffic_pending_check (
  user_id INTEGER PRIMARY KEY,
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
CREATE TABLE IF NOT EXISTS v2_payment (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, payment TEXT, config TEXT, enable INTEGER DEFAULT 0, uuid TEXT, icon TEXT, handling_fee_fixed INTEGER, handling_fee_percent REAL, notify_domain TEXT, sort INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS v2_commission_log (id INTEGER PRIMARY KEY AUTOINCREMENT, invite_user_id INTEGER, user_id INTEGER, order_id INTEGER, trade_no TEXT, order_amount INTEGER, get_amount INTEGER, amount INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS v2_migration_runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_name TEXT,
  source_size INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'merge',
  status TEXT NOT NULL DEFAULT 'running',
  source_counts TEXT,
  progress TEXT,
  report TEXT,
  error TEXT,
  access_token_hash TEXT,
  admin_id INTEGER,
  snapshot_counts TEXT,
  snapshot_complete INTEGER NOT NULL DEFAULT 0,
  skip_backup INTEGER NOT NULL DEFAULT 0,
  prepared_at INTEGER,
  rollback_progress TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_migration_snapshot_rows (
  run_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  row_data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, table_name, row_index)
);
CREATE INDEX IF NOT EXISTS idx_migration_snapshot_run_table ON v2_migration_snapshot_rows(run_id, table_name, row_index);
CREATE TABLE IF NOT EXISTS v2_migration_kv_snapshots (
  run_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  existed INTEGER NOT NULL DEFAULT 0,
  value TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, key_name)
);

CREATE TABLE IF NOT EXISTS v2_migration_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  table_name TEXT,
  message TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_migration_logs_run ON v2_migration_logs(run_id, id);
CREATE TABLE IF NOT EXISTS v2_gift_card_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, type INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 1, conditions TEXT, rewards TEXT NOT NULL, limits TEXT, special_config TEXT,
  icon TEXT, background_image TEXT, theme_color TEXT NOT NULL DEFAULT '#1890ff', sort INTEGER NOT NULL DEFAULT 0,
  admin_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_gift_card_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE, batch_id TEXT,
  status INTEGER NOT NULL DEFAULT 0, user_id INTEGER, used_at INTEGER, expires_at INTEGER, actual_rewards TEXT,
  usage_count INTEGER NOT NULL DEFAULT 0, max_usage INTEGER NOT NULL DEFAULT 1, metadata TEXT, redemption_nonce TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v2_gift_card_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER NOT NULL, template_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  invite_user_id INTEGER, rewards_given TEXT NOT NULL, invite_rewards TEXT, user_level_at_use INTEGER,
  plan_id_at_use INTEGER, multiplier_applied REAL NOT NULL DEFAULT 1, ip_address TEXT, user_agent TEXT, notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gift_template_type_status ON v2_gift_card_template(type, status);
CREATE INDEX IF NOT EXISTS idx_gift_template_created_at ON v2_gift_card_template(created_at);
CREATE INDEX IF NOT EXISTS idx_gift_code_template_id ON v2_gift_card_code(template_id);
CREATE INDEX IF NOT EXISTS idx_gift_code_status ON v2_gift_card_code(status);
CREATE INDEX IF NOT EXISTS idx_gift_code_batch_id ON v2_gift_card_code(batch_id);
CREATE INDEX IF NOT EXISTS idx_gift_code_expires_at ON v2_gift_card_code(expires_at);
CREATE INDEX IF NOT EXISTS idx_gift_code_user_id ON v2_gift_card_code(user_id);
CREATE INDEX IF NOT EXISTS idx_gift_code_lookup ON v2_gift_card_code(code, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_gift_usage_code_id ON v2_gift_card_usage(code_id);
CREATE INDEX IF NOT EXISTS idx_gift_usage_invite_user_id ON v2_gift_card_usage(invite_user_id);
CREATE INDEX IF NOT EXISTS idx_gift_usage_user_id ON v2_gift_card_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_gift_usage_created_at ON v2_gift_card_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_gift_usage_user_usage ON v2_gift_card_usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gift_usage_template_stats ON v2_gift_card_usage(template_id, created_at);

CREATE INDEX IF NOT EXISTS idx_personal_access_tokens_tokenable ON personal_access_tokens(tokenable_type, tokenable_id);
CREATE INDEX IF NOT EXISTS idx_v2_user_token ON v2_user(token);
CREATE INDEX IF NOT EXISTS idx_v2_user_next_reset_at ON v2_user(next_reset_at);
CREATE INDEX IF NOT EXISTS idx_v2_user_online ON v2_user(last_online_at, online_count);
CREATE INDEX IF NOT EXISTS idx_traffic_reset_user_time ON v2_traffic_reset_logs(user_id, reset_time);
CREATE INDEX IF NOT EXISTS idx_notice_sort ON v2_notice(sort);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_type_code ON v2_server(type, code) WHERE code IS NOT NULL AND code != '';
CREATE INDEX IF NOT EXISTS idx_v2_user_email ON v2_user(email);
CREATE INDEX IF NOT EXISTS idx_v2_server_enabled ON v2_server(enabled, show);
CREATE INDEX IF NOT EXISTS idx_v2_order_created_at ON v2_order(created_at);
CREATE INDEX IF NOT EXISTS idx_v2_order_status ON v2_order(status);
CREATE INDEX IF NOT EXISTS idx_v2_order_total_amount ON v2_order(total_amount);
CREATE INDEX IF NOT EXISTS idx_v2_order_commission_status ON v2_order(commission_status);
CREATE INDEX IF NOT EXISTS idx_v2_order_invite_user_id ON v2_order(invite_user_id);
CREATE INDEX IF NOT EXISTS idx_v2_order_commission_balance ON v2_order(commission_balance);
CREATE INDEX IF NOT EXISTS idx_v2_order_updated_at ON v2_order(updated_at);
CREATE INDEX IF NOT EXISTS idx_v2_commission_user ON v2_commission_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_v2_commission_order ON v2_commission_log(order_id);
CREATE INDEX IF NOT EXISTS idx_v2_ticket_status ON v2_ticket(status);
CREATE INDEX IF NOT EXISTS idx_v2_ticket_created_at ON v2_ticket(created_at);
CREATE INDEX IF NOT EXISTS idx_v2_stat_server_server ON v2_stat_server(server_id, record_at);
CREATE INDEX IF NOT EXISTS idx_v2_stat_server_record_server ON v2_stat_server(record_at, server_id, server_type);
CREATE INDEX IF NOT EXISTS idx_v2_user_availability ON v2_user(banned, expired_at, group_id, transfer_enable, u, d);
CREATE INDEX IF NOT EXISTS idx_v2_user_t ON v2_user(t);
CREATE INDEX IF NOT EXISTS idx_v2_user_online_count ON v2_user(online_count);
CREATE INDEX IF NOT EXISTS idx_v2_user_created_at ON v2_user(created_at);
CREATE INDEX IF NOT EXISTS idx_v2_server_sort ON v2_server(sort);
CREATE INDEX IF NOT EXISTS idx_v2_admin_audit_log_admin_id ON v2_admin_audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_v2_admin_audit_log_action ON v2_admin_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_v2_stat_user_record_user ON v2_stat_user(record_at, user_id);
CREATE INDEX IF NOT EXISTS idx_v2_commission_log_created_at ON v2_commission_log(created_at);
CREATE INDEX IF NOT EXISTS idx_v2_commission_log_get_amount ON v2_commission_log(get_amount);
