const SENSITIVE_KEY = /(^|_)(password|passwd|token|secret|private_key|secret_key|api_key|access_key|webhook_key|webhook_secret)(_|$)/i;

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
    key,
    key.toLowerCase() === "key" || SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactAuditValue(nested)
  ]));
}
