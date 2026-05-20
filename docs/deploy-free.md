# 免费部署建议：Telegraf + Webhook + Neon

本项目不需要全量切换到 TDLib。推荐保留 Telegraf / Bot API，把云端运行模式改成 webhook；业务数据继续使用 PostgreSQL。

## 推荐组合

- 后端：Koyeb Free / Render Free / Oracle Cloud Always Free VM
- 数据库：Neon Free PostgreSQL
- 前端原型：可选，Cloudflare Pages

## 部署前准备

1. 到 BotFather 创建机器人，拿到 `TELEGRAM_BOT_TOKEN`。
2. 到 Neon 创建 PostgreSQL，拿到 `DATABASE_URL`。
3. 第一次建表：

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
DATABASE_URL="你的 Neon 连接串" pnpm --filter @workspace/db run push
```

## Koyeb / Render 环境变量

```bash
NODE_ENV=production
DATABASE_URL=你的 Neon 连接串
TELEGRAM_BOT_TOKEN=你的 BotFather Token
TELEGRAM_WEBHOOK_URL=https://你的后端公网域名
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=一串随机密钥
TELEGRAM_DROP_PENDING_UPDATES=false
LOG_LEVEL=info
DIGEST_HOUR=9
DIGEST_MINUTE=0
```

说明：只要设置了 `TELEGRAM_WEBHOOK_URL` 或 `PUBLIC_URL`，后端会自动启用 webhook 模式。没有公网 URL 时会回退到 long polling，方便本地开发。

## 构建命令

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build
```

## 启动命令

```bash
pnpm --filter @workspace/api-server start
```

## 健康检查

```text
/api/healthz
```

部署成功后，访问：

```text
https://你的后端公网域名/api/healthz
```

返回：

```json
{"status":"ok"}
```

## 首次启动注意事项

数据库中的第一个 Telegram 用户会成为 OWNER。部署完成后，先用你自己的账号私聊机器人发送：

```text
/menu
```

确认你成为 OWNER 后，再把机器人加入群或频道。

## 本地开发

本地不设置 `TELEGRAM_WEBHOOK_URL`，直接运行 long polling：

```bash
PORT=3000 DATABASE_URL="你的连接串" TELEGRAM_BOT_TOKEN="你的 token" pnpm --filter @workspace/api-server start
```
