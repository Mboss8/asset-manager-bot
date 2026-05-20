# Free deployment guide: Bot API webhook mode

This project should keep **Telegraf + Telegram Bot API** as the main bot runtime. TDLib is not required for the current asset-manager workflow.

## Recommended free stack

- API/Bot server: Koyeb Free, Render Free, or an Oracle Cloud Always Free VM
- Database: Neon Free PostgreSQL
- Optional static frontend mockup: Cloudflare Pages

For a sleeping free container, webhook mode is usually cleaner than long polling. The API process exposes `/api/healthz`, while Telegram delivers bot updates to `/telegram/webhook`.

## Required environment variables

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require"
TELEGRAM_BOT_TOKEN="0000000000:replace_with_botfather_token"
TELEGRAM_WEBHOOK_URL="https://your-service.example.com/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="replace_with_random_A-Za-z0-9_-_secret"
TELEGRAM_DROP_PENDING_UPDATES=false
LOG_LEVEL=info
DIGEST_HOUR=9
DIGEST_MINUTE=0
```

`TELEGRAM_WEBHOOK_URL` is the switch:

- Set it in production: webhook mode starts automatically.
- Leave it empty locally: long polling starts automatically.

Generate a webhook secret with:

```bash
openssl rand -base64 48 | tr -dc 'A-Za-z0-9_-' | head -c 48
```

## Koyeb commands

Build command:

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build
```

Run command:

```bash
pnpm --filter @workspace/api-server start
```

Health check path:

```text
/api/healthz
```

After Koyeb gives you a public URL, set:

```bash
TELEGRAM_WEBHOOK_URL=https://YOUR-KOYEB-DOMAIN.koyeb.app/telegram/webhook
```

## Database initialization

Run once after creating the Neon database:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require" pnpm --filter @workspace/db run push
```

## First-run ownership rule

The first Telegram user that starts the bot becomes the initial owner. After deployment, privately message the bot first:

```text
/menu
```

Then add it to your group/channel and use:

```text
/chatid
```

## Local development

Leave `TELEGRAM_WEBHOOK_URL` empty and run the API normally. The bot will clear any previous webhook and use long polling.
