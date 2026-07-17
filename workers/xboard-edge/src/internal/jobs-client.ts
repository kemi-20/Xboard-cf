import type { Fetcher } from "../types";
import { internalAuthHeaders, type InternalAuthEnv } from "./auth";

type JobsClientEnv = InternalAuthEnv & { XBOARD_JOBS: Fetcher };

export type TestMailResult = {
  email: string;
  subject: string;
  template_name: string;
  error: string | null;
  config: {
    driver: "maileroo" | "brevo";
    host: string;
    port: 443;
    encryption: "HTTPS";
    from: { address: string; name: string };
    username: string;
  };
};

export type TestMailOptions = {
  templateName?: string;
  subject?: string;
  vars?: Record<string, unknown>;
  contentMode?: "text" | "html";
};

export async function sendTestMail(env: JobsClientEnv, email: string, options: TestMailOptions = {}): Promise<TestMailResult> {
  const response = await env.XBOARD_JOBS.fetch("https://xboard-jobs.internal/internal/mail/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...await internalAuthHeaders(env) },
    body: JSON.stringify({
      email,
      ...(options.templateName ? { template_name: options.templateName } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.vars ? { vars: options.vars } : {}),
      ...(options.contentMode ? { content_mode: options.contentMode } : {})
    })
  });
  const payload = await response.json().catch(() => ({})) as { data?: TestMailResult; message?: string };
  if (!response.ok || !payload.data) throw new Error(payload.message || `Test mail failed (${response.status})`);
  return payload.data;
}
