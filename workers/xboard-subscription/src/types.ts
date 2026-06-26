export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface D1Result<T = unknown> { results?: T[]; success: boolean; meta?: unknown; }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
export interface Queue<T = unknown> { send(message: T): Promise<void>; sendBatch(messages: { body: T }[]): Promise<void>; }
export interface Message<T = unknown> { body: T; ack(): void; retry(): void; }
export interface MessageBatch<T = unknown> { messages: Message<T>[]; queue: string; }
export interface DurableObjectState { storage: Map<string, unknown>; }
export interface DurableObjectNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub; }
export interface DurableObjectId {}
export interface DurableObjectStub { fetch(input: RequestInfo, init?: RequestInit): Promise<Response>; }
