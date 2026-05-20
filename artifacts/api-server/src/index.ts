import type { Server } from "node:http";
import type { Telegraf } from "telegraf";

import app from "./app.js";
import { logger } from "./lib/logger.js";
import { createBot } from "./bot/index.js";
import { startReminderScheduler } from "./bot/reminders.js";

const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;
const DEFAULT_WEBHOOK_PATH = "/telegram/webhook";
const SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

type WebhookConfig = {
  url: string;
  path: string;
  secretToken?: string;
  dropPendingUpdates: boolean;
};

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value: true/false, 1/0, yes/no, on/off.`);
}

function normalizeWebhookPath(rawPath: string | undefined): string {
  const trimmed = rawPath?.trim();
  if (!trimmed) return DEFAULT_WEBHOOK_PATH;

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.includes("?") || withSlash.includes("#")) {
    throw new Error("TELEGRAM_WEBHOOK_PATH must be a clean path without query string or hash.");
  }

  return withSlash.replace(/\/+$/, "") || DEFAULT_WEBHOOK_PATH;
}

function getWebhookConfig(): WebhookConfig | null {
  const rawUrl = process.env["TELEGRAM_WEBHOOK_URL"]?.trim();
  if (!rawUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL, for example: https://example.com/telegram/webhook");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("TELEGRAM_WEBHOOK_URL must use https:// because Telegram webhooks require HTTPS.");
  }

  const pathFromUrl = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : undefined;
  const path = normalizeWebhookPath(process.env["TELEGRAM_WEBHOOK_PATH"] ?? pathFromUrl);
  const url = `${parsed.origin}${path}`;

  const secretToken = process.env["TELEGRAM_WEBHOOK_SECRET"]?.trim();
  if (secretToken && !SECRET_TOKEN_RE.test(secretToken)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 1-256 chars and only contain A-Z, a-z, 0-9, _ or -.");
  }
  if (!secretToken) {
    logger.warn("TELEGRAM_WEBHOOK_SECRET not set — webhook will accept requests without Telegram secret-token validation");
  }

  return {
    url,
    path,
    secretToken: secretToken || undefined,
    dropPendingUpdates: readBooleanEnv("TELEGRAM_DROP_PENDING_UPDATES", false),
  };
}

async function installBotCommands(bot: Telegraf): Promise<void> {
  try {
    await bot.telegram.setMyCommands([
      { command: "menu", description: "打开主控面板" },
      { command: "help", description: "查看帮助" },
      { command: "cancel", description: "取消当前操作" },
      { command: "chatid", description: "查看当前会话 ID" },
      { command: "digest", description: "立即推送每日提醒（管理员）" },
    ]);
  } catch (err: unknown) {
    logger.warn({ err }, "Failed to set bot commands");
  }
}

async function startScheduler(bot: Telegraf): Promise<void> {
  try {
    await startReminderScheduler(bot.telegram);
  } catch (err: unknown) {
    logger.error({ err }, "Failed to start reminder scheduler");
  }
}

async function startBot(bot: Telegraf, webhook: WebhookConfig | null): Promise<void> {
  await installBotCommands(bot);

  if (webhook) {
    await bot.telegram.setWebhook(webhook.url, {
      allowed_updates: [...ALLOWED_UPDATES],
      drop_pending_updates: webhook.dropPendingUpdates,
      ...(webhook.secretToken ? { secret_token: webhook.secretToken } : {}),
    });

    logger.info(
      {
        url: webhook.url,
        path: webhook.path,
        secretConfigured: Boolean(webhook.secretToken),
        dropPendingUpdates: webhook.dropPendingUpdates,
      },
      "Telegram bot started (webhook)",
    );
    await startScheduler(bot);
    return;
  }

  // Local/dev fallback. When no webhook URL is configured, clear any previous
  // webhook first; Telegram does not allow getUpdates while a webhook exists.
  try {
    await bot.telegram.deleteWebhook({
      drop_pending_updates: readBooleanEnv("TELEGRAM_DROP_PENDING_UPDATES", false),
    });
  } catch (err: unknown) {
    logger.warn({ err }, "Failed to delete existing webhook before polling startup");
  }

  
  if (!process.env.TELEGRAM_WEBHOOK_URL) {
    throw new Error("TELEGRAM_WEBHOOK_URL is required in production");
  }

  const webhookPath =
    process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook";

  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, "") + webhookPath;

  await bot.telegram.deleteWebhook({
    drop_pending_updates: false,
  });

  await bot.telegram.setWebhook(webhookUrl);

  app.use(bot.webhookCallback(webhookPath));

  logger.info(
    {
      webhookUrl,
      webhookPath,
    },
    "Telegram bot started (webhook mode)",
  );
    void startScheduler(bot);
  });
}

function stopServer(server: Server, signal: "SIGINT" | "SIGTERM"): void {
  logger.info({ signal }, "Shutting down server");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error while closing HTTP server");
      process.exit(1);
    }
    process.exit(0);
  });
}

const botToken = process.env["TELEGRAM_BOT_TOKEN"];
const bot = botToken ? createBot(botToken) : null;
const webhook = bot ? getWebhookConfig() : null;

if (!botToken) {
  logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
}

if (bot && webhook) {
  const webhookCallback = bot.webhookCallback(webhook.path, {
    secretToken: webhook.secretToken,
  });

  // Register at app root so Telegraf can match the original request URL.
  // Non-webhook requests fall through to the rest of Express via next().
  app.use((req, res, next) => {
    void webhookCallback(req, res, next).catch(next);
  });
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");

  if (!bot) return;
  void startBot(bot, webhook).catch((startupErr: unknown) => {
    logger.error({ err: startupErr }, "Telegram bot startup failed");
    if (process.env.NODE_ENV === "production") process.exit(1);
  });
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

process.once("SIGINT", () => {
  try {
    if (bot && !webhook) bot.stop("SIGINT");
  } catch (err: unknown) {
    logger.warn({ err }, "Bot stop failed");
  }
  stopServer(server, "SIGINT");
});

process.once("SIGTERM", () => {
  try {
    if (bot && !webhook) bot.stop("SIGTERM");
  } catch (err: unknown) {
    logger.warn({ err }, "Bot stop failed");
  }
  stopServer(server, "SIGTERM");
});
