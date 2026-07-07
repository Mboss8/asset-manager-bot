import { performance } from "node:perf_hooks";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";
import { redisService } from "../redis/index.js";

type DependencyHealth = {
  status: "up" | "down" | "disabled";
  latencyMs: number | null;
  error?: string;
};

const router: IRouter = Router();

async function checkDatabase(): Promise<DependencyHealth> {
  const started = performance.now();
  try {
    await pool.query("select 1");
    return { status: "up", latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function buildHealth() {
  const [database, redis] = await Promise.all([checkDatabase(), redisService.ping()]);
  const healthy = database.status === "up" && ["up", "disabled"].includes(redis.status);

  return {
    status: healthy ? "healthy" : "degraded",
    database,
    redis: {
      status: redis.status,
      latencyMs: redis.latencyMs,
      enabled: redis.enabled,
      ...(redis.error ? { error: redis.error } : {}),
    },
  };
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/v1/health", async (_req, res, next) => {
  try {
    const data = await buildHealth();
    res.status(data.status === "healthy" ? 200 : 503).json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
