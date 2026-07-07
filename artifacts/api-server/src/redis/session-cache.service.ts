import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { REDIS_KEYS, REDIS_TTL } from "./redis.constants.js";
import { redisService } from "./redis.service.js";

export type JwtSessionPayload = {
  jti: string;
  subject: string;
  userId?: number | string;
  tenantId?: number | string;
  issuedAt: number;
  expiresAt: number;
  metadata?: Record<string, unknown>;
};

type InMemorySession = {
  payload: JwtSessionPayload;
  expiresAtMs: number;
};

export class SessionCacheService {
  private readonly fallbackSessions = new Map<string, InMemorySession>();

  createJti(): string {
    return randomUUID();
  }

  async createSession(input: Omit<JwtSessionPayload, "issuedAt" | "expiresAt"> & { ttlSeconds?: number }): Promise<JwtSessionPayload> {
    const now = Math.floor(Date.now() / 1000);
    const ttlSeconds = input.ttlSeconds ?? REDIS_TTL.jwtSessionSeconds;
    const payload: JwtSessionPayload = {
      jti: input.jti,
      subject: input.subject,
      userId: input.userId,
      tenantId: input.tenantId,
      metadata: input.metadata,
      issuedAt: now,
      expiresAt: now + ttlSeconds,
    };

    const key = REDIS_KEYS.session(payload.jti);
    const value = JSON.stringify(payload);

    try {
      const ok = await redisService.setEx(key, ttlSeconds, value);
      if (ok) return payload;
    } catch (err) {
      logger.warn({ err, jti: payload.jti }, "Redis session create failed — using in-process fallback");
    }

    this.fallbackSessions.set(key, {
      payload,
      expiresAtMs: Date.now() + ttlSeconds * 1000,
    });
    return payload;
  }

  async validateSession(jti: string): Promise<JwtSessionPayload | null> {
    const key = REDIS_KEYS.session(jti);

    try {
      const raw = await redisService.get(key);
      if (raw) return JSON.parse(raw) as JwtSessionPayload;
      if (redisService.isAvailable()) return null;
    } catch (err) {
      logger.warn({ err, jti }, "Redis session validate failed — using in-process fallback");
    }

    const fallback = this.fallbackSessions.get(key);
    if (!fallback) return null;
    if (fallback.expiresAtMs <= Date.now()) {
      this.fallbackSessions.delete(key);
      return null;
    }
    return fallback.payload;
  }

  async revokeSession(jti: string): Promise<boolean> {
    const key = REDIS_KEYS.session(jti);
    let revoked = false;

    try {
      const deleted = await redisService.del(key);
      revoked = deleted > 0;
      if (redisService.isAvailable()) return revoked;
    } catch (err) {
      logger.warn({ err, jti }, "Redis session revoke failed — using in-process fallback");
    }

    revoked = this.fallbackSessions.delete(key) || revoked;
    return revoked;
  }
}

export const sessionCacheService = new SessionCacheService();
