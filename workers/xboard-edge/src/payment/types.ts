import type { D1Database, KVNamespace } from "../types.ts";

export type PaymentEnv = {
  XBOARD_DB: D1Database;
  XBOARD_KV: KVNamespace;
};

export type PaymentConfig = Record<string, unknown>;

export type PaymentFormField = {
  type: "string" | "text" | "select";
  label: string;
  required?: boolean;
  placeholder?: string;
  description?: string;
  default?: string;
  options?: Array<{ label: string; value: string }>;
};

export type CheckoutContext = {
  config: PaymentConfig;
  tradeNo: string;
  amount: number;
  currency: string;
  userId: number;
  userEmail: string;
  appName: string;
  notifyUrl: string;
  returnUrl: string;
  idempotencyKey: string;
};

export type CheckoutResult = {
  type: 0 | 1;
  data: string;
  providerReference?: string;
  expiresAt?: number;
};

export type CallbackResult = {
  state: "paid" | "pending" | "ignored";
  tradeNo?: string;
  callbackNo?: string;
  providerReference?: string;
  amount?: number;
  currency?: string;
  responseText: string;
};

export type PaymentProvider = {
  method: string;
  name: string;
  icon: string;
  form: Record<string, PaymentFormField>;
  validateConfig(config: PaymentConfig): void;
  createCheckout(context: CheckoutContext): Promise<CheckoutResult>;
  verifyCallback(request: Request, config: PaymentConfig): Promise<CallbackResult>;
};

export type PaymentRow = {
  id: number;
  name: string;
  payment: string;
  config: string | PaymentConfig | null;
  enable: number;
  uuid: string;
  icon: string | null;
  handling_fee_fixed: number | null;
  handling_fee_percent: number | null;
  notify_domain: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
};
