import { logger } from "../lib/logger.js";
import { REDIS_KEYS, REDIS_TTL } from "./redis.constants.js";
import { redisService } from "./redis.service.js";

type SeenUpdate = {
  expiresAt: number;
};

export class WebhookDedupService {
  private readonly fallbackSeen = new Map<string, SeenUpdate>();

  async mark(updateId: number | string, ttlSeconds = REDIS_TTL.webhookDedupSeconds): Promise<{ duplicate: boolean; degraded: boolean }> {
    const key = REDIS_KEYS.webhookUpdate(updateId);

    try {
      const inserted = await redisService.setNxEx(key, "1", ttlSeconds);
      if (inserted) return { duplicate: false, degraded: false };
      if (redisService.isAvailable()) return { duplicate: true, degraded: false };
    } catch (err) {
      logger.warn({ err, updateId }, "Redis webhook dedup failed — using in-process fallback");
    }

    this.sweepFallback();
    const now = Date.now();
    const existing = this.fallbackSeen.get(key);
    if (existing && existing.expiresAt > now) return { duplicate: true, degraded: true };
    this.fallbackSeen.set(key, { expiresAt: now + ttlSeconds * 1000 });
    return { duplicate: false, degraded: true };
  }

  private sweepFallback(): void {
    const now = Date.now();
    for (const [key, value] of this.fallbackSeen.entries()) {
      if (value.expiresAt <= now) this.fallbackSeen.delete(key);
    }
  }
}

export const webhookDedupService = new WebhookDedupService();
