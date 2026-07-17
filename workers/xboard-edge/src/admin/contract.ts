const adminTableRoutes: Array<[string, string]> = [
  ["/server/group/", "v2_server_group"],
  ["/server/route/", "v2_server_route"],
  ["/server/machine/", "v2_server_machine"],
  ["/server/manage/", "v2_server"],
  ["/mail/template/", "v2_mail_templates"],
  ["/user/", "v2_user"],
  ["/plan/", "v2_plan"],
  ["/notice/", "v2_notice"],
  ["/knowledge/", "v2_knowledge"],
  ["/ticket/", "v2_ticket"],
  ["/audit/", "v2_admin_audit_log"]
];

export function adminTableForPath(path: string) {
  return adminTableRoutes.find(([route]) => path.includes(route))?.[1];
}

export const directFetchTables: Record<string, string> = {
  "/server/manage/getNodes": "v2_server",
  "/server/machine/fetch": "v2_server_machine",
  "/server/group/fetch": "v2_server_group",
  "/server/route/fetch": "v2_server_route",
  "/notice/fetch": "v2_notice",
  "/knowledge/fetch": "v2_knowledge",
  "/plan/fetch": "v2_plan",
  "/payment/fetch": "v2_payment"
};

export const pagedFetchTables: Record<string, string> = {
  "/user/fetch": "v2_user",
  "/ticket/fetch": "v2_ticket",
  "/order/fetch": "v2_order",
  "/coupon/fetch": "v2_coupon",
  "/gift-card/templates": "v2_gift_card_template",
  "/gift-card/codes": "v2_gift_card_code",
  "/gift-card/usages": "v2_gift_card_usage"
};

const adminRouteMethods: Record<string, string[]> = {
  "/config/fetch": ["GET"], "/config/save": ["POST"], "/config/getEmailTemplate": ["GET"], "/config/getThemeTemplate": ["GET"],
  "/config/setTelegramWebhook": ["POST"], "/config/testSendMail": ["POST"],
  "/mail/template/list": ["GET"], "/mail/template/get": ["GET"], "/mail/template/save": ["POST"], "/mail/template/reset": ["POST"], "/mail/template/test": ["POST"],
  "/plan/fetch": ["GET"], "/plan/save": ["POST"], "/plan/drop": ["POST"], "/plan/update": ["POST"], "/plan/sort": ["POST"],
  "/server/group/fetch": ["GET"], "/server/group/save": ["POST"], "/server/group/drop": ["POST"],
  "/server/route/fetch": ["GET"], "/server/route/save": ["POST"], "/server/route/drop": ["POST"],
  "/server/manage/getNodes": ["GET"], "/server/manage/update": ["POST"], "/server/manage/save": ["POST"], "/server/manage/drop": ["POST"],
  "/server/manage/copy": ["POST"], "/server/manage/sort": ["POST"], "/server/manage/batchDelete": ["POST"], "/server/manage/batchUpdate": ["POST"],
  "/server/manage/resetTraffic": ["POST"], "/server/manage/batchResetTraffic": ["POST"], "/server/manage/generateEchKey": ["GET"],
  "/server/machine/fetch": ["GET"], "/server/machine/save": ["POST"], "/server/machine/drop": ["POST"], "/server/machine/resetToken": ["POST"],
  "/server/machine/getToken": ["GET"], "/server/machine/installCommand": ["GET"], "/server/machine/nodes": ["GET"], "/server/machine/history": ["GET"],
  "/order/fetch": ["GET", "POST"], "/order/update": ["POST"], "/order/assign": ["POST"], "/order/paid": ["POST"], "/order/cancel": ["POST"], "/order/detail": ["POST"],
  "/user/fetch": ["GET", "POST"], "/user/update": ["POST"], "/user/getUserInfoById": ["GET"], "/user/generate": ["POST"], "/user/dumpCSV": ["POST"],
  "/user/sendMail": ["POST"], "/user/ban": ["POST"], "/user/resetSecret": ["POST"], "/user/setInviteUser": ["POST"], "/user/destroy": ["POST"], "/user/getSubscribe": ["GET"],
  "/stat/getOverride": ["GET"], "/stat/getStats": ["GET"], "/stat/getServerLastRank": ["GET"], "/stat/getServerYesterdayRank": ["GET"],
  "/stat/getOrder": ["GET"], "/stat/getStatUser": ["GET", "POST"], "/stat/getRanking": ["GET"], "/stat/getStatRecord": ["GET"], "/stat/getTrafficRank": ["GET"],
  "/notice/fetch": ["GET"], "/notice/save": ["POST"], "/notice/update": ["POST"], "/notice/drop": ["POST"], "/notice/show": ["POST"], "/notice/sort": ["POST"],
  "/ticket/fetch": ["GET", "POST"], "/ticket/reply": ["POST"], "/ticket/close": ["POST"],
  "/coupon/fetch": ["GET", "POST"], "/coupon/generate": ["POST"], "/coupon/drop": ["POST"], "/coupon/show": ["POST"], "/coupon/update": ["POST"],
  "/knowledge/fetch": ["GET"], "/knowledge/getCategory": ["GET"], "/knowledge/save": ["POST"], "/knowledge/show": ["POST"], "/knowledge/drop": ["POST"], "/knowledge/sort": ["POST"],
  "/payment/fetch": ["GET"], "/payment/getPaymentMethods": ["GET"], "/payment/getPaymentForm": ["POST"], "/payment/save": ["POST"], "/payment/drop": ["POST"], "/payment/show": ["POST"], "/payment/sort": ["POST"],
  "/system/getSystemStatus": ["GET"], "/system/getQueueStats": ["GET"], "/system/getQueueWorkload": ["GET"], "/system/getQueueMasters": ["GET"],
  "/system/getHorizonFailedJobs": ["GET"], "/system/getAuditLog": ["GET", "POST"],
  "/theme/getThemes": ["GET"], "/theme/upload": ["POST"], "/theme/delete": ["POST"], "/theme/saveThemeConfig": ["POST"], "/theme/getThemeConfig": ["POST"],
  "/plugin/types": ["GET"], "/plugin/getPlugins": ["GET"], "/plugin/upload": ["POST"], "/plugin/delete": ["POST"], "/plugin/install": ["POST"],
  "/plugin/uninstall": ["POST"], "/plugin/enable": ["POST"], "/plugin/disable": ["POST"], "/plugin/config": ["GET", "POST"], "/plugin/upgrade": ["POST"],
  "/traffic-reset/logs": ["GET"], "/traffic-reset/stats": ["GET"], "/traffic-reset/reset-user": ["POST"],
  "/migration/status": ["GET"], "/migration/export/manifest": ["GET"], "/migration/export/table": ["POST"],
  "/migration/start": ["POST"], "/migration/snapshot/table": ["POST"], "/migration/snapshot/finish": ["POST"],
  "/migration/prepare": ["POST"], "/migration/batch": ["POST"], "/migration/redis/import": ["POST"],
  "/migration/abort": ["POST"], "/migration/rollback/start": ["POST"], "/migration/rollback/table": ["POST"],
  "/migration/rollback/finish": ["POST"], "/migration/finish": ["POST"]
};

export const allowedConfigSettings = new Set([
  "invite_force", "invite_commission", "invite_gen_limit", "invite_never_expire", "commission_first_time_enable", "commission_auto_check_enable",
  "commission_withdraw_limit", "commission_withdraw_method", "withdraw_close_enable", "commission_distribution_enable", "commission_distribution_l1",
  "commission_distribution_l2", "commission_distribution_l3", "logo", "force_https", "stop_register", "app_name", "app_description", "app_url",
  "subscribe_url", "try_out_enable", "try_out_plan_id", "try_out_hour", "tos_url", "currency", "currency_symbol", "ticket_must_wait_reply",
  "plan_change_enable", "reset_traffic_method", "surplus_enable", "new_order_event_id", "renew_order_event_id", "change_order_event_id",
  "show_info_to_server_enable", "show_protocol_to_server_enable", "subscribe_path", "server_token", "server_pull_interval", "server_push_interval",
  "device_limit_mode", "server_ws_enable", "server_ws_url", "frontend_theme", "frontend_theme_sidebar", "frontend_theme_header", "frontend_theme_color",
  "frontend_background_url", "email_driver", "email_host", "email_port", "email_username", "email_password", "email_from_address",
  "remind_mail_enable", "resend_api_url", "resend_api_key", "resend_from_name", "resend_from_address", "telegram_bot_enable", "telegram_bot_token",
  "telegram_webhook_url", "telegram_discuss_id", "telegram_channel_id", "telegram_discuss_link", "windows_version", "windows_download_url",
  "macos_version", "macos_download_url", "android_version", "android_download_url", "email_whitelist_enable", "email_whitelist_suffix",
  "email_gmail_limit_enable", "captcha_enable", "captcha_type", "recaptcha_enable", "recaptcha_key", "recaptcha_site_key", "recaptcha_v3_secret_key",
  "recaptcha_v3_site_key", "recaptcha_v3_score_threshold", "turnstile_secret_key", "turnstile_site_key", "email_verify", "safe_mode_enable",
  "register_limit_by_ip_enable", "register_limit_count", "register_limit_expire", "secure_path", "password_limit_enable", "password_limit_count",
  "password_limit_expire", "default_remind_expire", "default_remind_traffic", "login_with_mail_link_enable", "frontend_admin_path"
]);

export const integerConfigSettings = new Set([
  "invite_force", "invite_commission", "invite_gen_limit", "invite_never_expire", "commission_first_time_enable", "commission_auto_check_enable",
  "withdraw_close_enable", "commission_distribution_enable", "force_https", "stop_register", "try_out_enable", "try_out_plan_id", "ticket_must_wait_reply",
  "plan_change_enable", "reset_traffic_method", "surplus_enable", "new_order_event_id", "renew_order_event_id", "change_order_event_id",
  "show_info_to_server_enable", "show_protocol_to_server_enable", "server_pull_interval", "server_push_interval", "device_limit_mode", "server_ws_enable",
  "remind_mail_enable", "telegram_bot_enable", "email_whitelist_enable", "email_gmail_limit_enable", "captcha_enable", "recaptcha_enable",
  "email_verify", "safe_mode_enable", "register_limit_by_ip_enable", "register_limit_count", "register_limit_expire", "password_limit_enable",
  "password_limit_count", "password_limit_expire", "default_remind_expire", "default_remind_traffic", "login_with_mail_link_enable"
]);

export const numericConfigSettings = new Set([
  "commission_withdraw_limit", "commission_distribution_l1", "commission_distribution_l2", "commission_distribution_l3", "try_out_hour",
  "recaptcha_v3_score_threshold"
]);

export const urlConfigSettings = new Set([
  "logo", "app_url", "tos_url", "server_ws_url", "frontend_background_url", "telegram_webhook_url", "telegram_discuss_link",
  "windows_download_url", "macos_download_url", "android_download_url"
]);

export function adminRouteAllowed(route: string, method: string) {
  if (/^\/traffic-reset\/user\/\d+\/history$/.test(route)) return method === "GET";
  if (/^\/gift-card\/(templates|codes|usages|statistics)$/.test(route)) return method === "GET" || method === "POST";
  if (/^\/gift-card\/(create-template|update-template|delete-template|generate-codes|toggle-code|update-code|delete-code)$/.test(route)) return method === "POST";
  if (/^\/gift-card\/(export-codes|types)$/.test(route)) return method === "GET";
  return adminRouteMethods[route]?.includes(method) === true;
}
