import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { REDIS_KEYS, REDIS_TTL } from "./redis.constants.js";
import { redisService } from "./redis.service.js";

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

type InMemoryLock = {
  token: string;
  expiresAt: number;
};

export class RedisLockService {
  private readonly fallbackLocks = new Map<string, InMemoryLock>();

  async acquire(name: string, ttlSeconds = REDIS_TTL.lockSeconds): Promise<string | null> {
    const token = randomUUID();
    const key = REDIS_KEYS.lock(name);

    try {
      const acquired = await redisService.setNxEx(key, token, ttlSeconds);
      if (acquired) return token;
      if (redisService.isAvailable()) return null;
    } catch (err) {
      logger.warn({ err, lock: name }, "Redis lock acquire failed — using in-process fallback");
    }

    const now = Date.now();
    const existing = this.fallbackLocks.get(key);
    if (existing && existing.expiresAt > now) return null;
    this.fallbackLocks.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
    return token;
  }

  async release(name: string, token: string): Promise<void> {
    const key = REDIS_KEYS.lock(name);

    try {
      const released = await redisService.eval(RELEASE_LOCK_SCRIPT, [key], [token]);
      if (released !== null) return;
    } catch (err) {
      logger.warn({ err, lock: name }, "Redis lock release failed — using in-process fallback");
    }

    const existing = this.fallbackLocks.get(key);
    if (existing?.token === token) this.fallbackLocks.delete(key);
  }

  async withLock<T>(name: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    const token = await this.acquire(name, ttlSeconds);
    if (!token) return null;

    try {
      return await fn();
    } finally {
      await this.release(name, token);
    }
  }
}

export const redisLockService = new RedisLockService();
