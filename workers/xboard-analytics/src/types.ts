export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  ANALYTICS_API_TOKEN?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
