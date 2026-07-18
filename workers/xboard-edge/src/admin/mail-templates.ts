import type { D1Database, Queue } from "../types.ts";

type MailEnv = { XBOARD_DB: D1Database; NOTIFICATION_EVENTS: Queue };

export const mailTemplateMeta: Record<string, { label: string; required_vars: string[]; optional_vars: string[] }> = {
  verify: { label: "邮箱验证码", required_vars: ["code"], optional_vars: ["name", "url"] },
  mailLogin: { label: "邮件快捷登录", required_vars: ["link"], optional_vars: ["name", "url"] },
  notify: { label: "站点通知", required_vars: ["content"], optional_vars: ["name", "url"] },
  remindExpire: { label: "服务到期提醒", required_vars: [], optional_vars: ["name", "url"] },
  remindTraffic: { label: "流量使用提醒", required_vars: [], optional_vars: ["name", "url"] }
};

const mailTemplateDefaults: Record<string, { subject: string; content: string }> = {
  verify: { subject: "{{name}} - 邮箱验证码", content: "您的验证码是：{{code}}。返回 {{url}}" },
  mailLogin: { subject: "登录到 {{name}}", content: "请使用以下链接登录：{{link}}\n\n{{url}}" },
  notify: { subject: "{{name}} - 站点通知", content: "{{content}}\n\n{{url}}" },
  remindExpire: { subject: "{{name}} - 服务即将到期", content: "您的服务即将到期，请及时续费。{{url}}" },
  remindTraffic: { subject: "{{name}} - 流量使用提醒", content: "您的流量使用量已接近上限。{{url}}" }
};

export function canonicalMailTemplateName(name: string) {
  return name === "remind_expire" ? "remindExpire" : name === "remind_traffic" ? "remindTraffic" : name;
}

export function legacyMailTemplateName(name: string) {
  return name === "remindExpire" ? "remind_expire" : name === "remindTraffic" ? "remind_traffic" : name;
}

export async function adminMailTemplateList(env: MailEnv) {
  const result = await env.XBOARD_DB.prepare("SELECT name, subject, updated_at FROM v2_mail_templates").all<Record<string, any>>();
  const templates = new Map((result.results || []).map(row => [canonicalMailTemplateName(String(row.name)), row]));
  return Object.entries(mailTemplateMeta).map(([name, meta]) => ({
    name,
    label: meta.label,
    customized: templates.has(name),
    subject: templates.get(name)?.subject || null,
    updated_at: templates.get(name)?.updated_at || null
  }));
}

export async function adminMailTemplateGet(env: MailEnv, rawName: string) {
  const name = canonicalMailTemplateName(rawName);
  const meta = mailTemplateMeta[name];
  if (!meta) return null;
  const row = await env.XBOARD_DB.prepare("SELECT name, subject, content FROM v2_mail_templates WHERE name IN (?, ?) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END LIMIT 1")
    .bind(name, legacyMailTemplateName(name), name).first<Record<string, any>>();
  return {
    name,
    label: meta.label,
    required_vars: meta.required_vars,
    optional_vars: meta.optional_vars,
    customized: Boolean(row),
    subject: row?.subject || mailTemplateDefaults[name].subject,
    content: row?.content || mailTemplateDefaults[name].content
  };
}

export function renderMailText(source: string, vars: Record<string, unknown>) {
  return source.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => String(vars[key] ?? ""));
}

export async function queueTemplateMail(env: MailEnv, name: string, email: string, vars: Record<string, unknown>, subjectOverride?: string) {
  const template = await adminMailTemplateGet(env, name);
  if (!template) throw new Error("模板不存在");
  const eventId = `mail:${crypto.randomUUID()}`;
  await env.NOTIFICATION_EVENTS.send({
    event_id: eventId,
    type: "mail",
    payload: { to: email, subject: subjectOverride || template.subject, template_name: canonicalMailTemplateName(name), vars, content_mode: "text" }
  });
  return eventId;
}
