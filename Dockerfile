FROM node:22

RUN corepack enable

WORKDIR /app

COPY . .

RUN corepack prepare pnpm@9.15.9 --activate

RUN pnpm install --no-frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

EXPOSE 3000

CMD ["pnpm", "--filter", "@workspace/api-server", "start"]
