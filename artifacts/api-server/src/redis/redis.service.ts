import Redis from "ioredis";
import { logger } from "../lib/logger.js";
import { REDIS_DEFAULT_KEY_PREFIX, REDIS_DEFAULT_URL } from "./redis.constants.js";

export type RedisHealth = {
  enabled: boolean;
  status: "up" | "down" | "disabled";
  latencyMs: number | null;
  error?: string;
};

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value: true/false, 1/0, yes/no, on/off.`);
}

function isStrictRuntime(): boolean {
  return ["production", "staging"].includes(process.env.NODE_ENV ?? "");
}

export class RedisService {
  private client: Redis | null = null;
  private connectPromise: Promise<Redis | null> | null = null;
  private lastError: string | undefined;

  readonly enabled = readBooleanEnv("REDIS_ENABLED", true);
  readonly url = process.env.REDIS_URL?.trim() || REDIS_DEFAULT_URL;
  readonly keyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || REDIS_DEFAULT_KEY_PREFIX;

  isEnabled(): boolean {
    return this.enabled;
  }

  isAvailable(): boolean {
    return Boolean(this.client && this.client.status === "ready");
  }

  key(name: string): string {
    return `${this.keyPrefix}${name}`;
  }

  async getClient(): Promise<Redis | null> {
    if (!this.enabled) {
      if (isStrictRuntime()) {
        throw new Error("REDIS_ENABLED=false is only allowed outside staging/production.");
      }
      return null;
    }

    if (this.client?.status === "ready") return this.client;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.connect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connect(): Promise<Redis | null> {
    const client = new Redis(this.url, {
      lazyConnect: true,
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        return Math.min(times * 100, 2_000);
      },
    });

    client.on("error", (err) => {
      this.lastError = err.message;
      logger.warn({ err }, "Redis client error");
    });

    try {
      await client.connect();
      await client.ping();
      this.client = client;
      this.lastError = undefined;
      logger.info({ url: this.redactedUrl(), keyPrefix: this.keyPrefix }, "Redis connected");
      return client;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        client.disconnect();
      } catch {
        // no-op
      }

      if (isStrictRuntime()) {
        throw err;
      }

      logger.warn({ err, url: this.redactedUrl() }, "Redis unavailable — running in degraded in-process mode");
      return null;
    }
  }

  private redactedUrl(): string {
    try {
      const parsed = new URL(this.url);
      if (parsed.password) parsed.password = "***";
      if (parsed.username) parsed.username = "***";
      return parsed.toString();
    } catch {
      return "<invalid-url>";
    }
  }

  async ping(): Promise<RedisHealth> {
    if (!this.enabled) {
      return { enabled: false, status: "disabled", latencyMs: null };
    }

    const started = Date.now();
    try {
      const client = await this.getClient();
      if (!client) {
        return { enabled: true, status: "down", latencyMs: null, error: this.lastError };
      }
      await client.ping();
      return { enabled: true, status: "up", latencyMs: Date.now() - started };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.lastError = error;
      return { enabled: true, status: "down", latencyMs: Date.now() - started, error };
    }
  }

  async setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const client = await this.getClient();
    if (!client) return false;
    const result = await client.set(this.key(key), value, "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async get(key: string): Promise<string | null> {
    const client = await this.getClient();
    if (!client) return null;
    return client.get(this.key(key));
  }

  async setEx(key: string, ttlSeconds: number, value: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) return false;
    const result = await client.set(this.key(key), value, "EX", ttlSeconds);
    return result === "OK";
  }

  async del(key: string): Promise<number> {
    const client = await this.getClient();
    if (!client) return 0;
    return client.del(this.key(key));
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const client = await this.getClient();
    if (!client) return null;
    return client.eval(script, keys.length, ...keys.map((key) => this.key(key)), ...args);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await this.client.quit();
    this.client = null;
  }
}

export const redisService = new RedisService();
