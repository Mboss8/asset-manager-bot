export const REDIS_DEFAULT_URL = "redis://localhost:6380";
export const REDIS_DEFAULT_KEY_PREFIX = "tgops:";

export const REDIS_TTL = {
  webhookDedupSeconds: 24 * 60 * 60,
  lockSeconds: 30,
  jwtSessionSeconds: 7 * 24 * 60 * 60,
} as const;

export const REDIS_KEYS = {
  lock: (name: string) => `lock:${name}`,
  session: (jti: string) => `session:${jti}`,
  webhookUpdate: (updateId: number | string) => `webhook:update:${updateId}`,
} as const;
