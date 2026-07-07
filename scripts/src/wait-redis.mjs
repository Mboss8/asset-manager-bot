import net from "node:net";

const rawUrl = process.env.REDIS_URL || "redis://localhost:6380";
const timeoutMs = Number(process.env.REDIS_WAIT_TIMEOUT_MS || 30_000);
const intervalMs = Number(process.env.REDIS_WAIT_INTERVAL_MS || 500);

let parsed;
try {
  parsed = new URL(rawUrl);
} catch {
  console.error(`Invalid REDIS_URL: ${rawUrl}`);
  process.exit(1);
}

const host = parsed.hostname || "localhost";
const port = Number(parsed.port || 6379);
const deadline = Date.now() + timeoutMs;

function probe() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

while (Date.now() < deadline) {
  if (await probe()) {
    console.log(`Redis is reachable at ${host}:${port}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

console.error(`Timed out waiting for Redis at ${host}:${port}`);
process.exit(1);
