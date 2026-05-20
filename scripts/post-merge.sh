#!/usr/bin/env bash
set -euo pipefail

# Always run from the workspace root, no matter where Replit invokes this hook.
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push
