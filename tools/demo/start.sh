#!/usr/bin/env bash
# Runs the whole app locally against the mock GitHub and mock Anthropic (tools/mock-github),
# with the demo seed. Nothing real is contacted. Ctrl+C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="$(dirname "$(command -v node)"):$PATH"
# global-setup and the scripts call `pnpm` by name, so give them a shim that runs the pinned version.
SHIM="$(mktemp -d)"
printf '#!/usr/bin/env bash\nexec npx --yes -p pnpm@9 pnpm "$@"\n' > "$SHIM/pnpm"
chmod +x "$SHIM/pnpm"
export PATH="$SHIM:$PATH"
PNPM=pnpm

MOCK=http://localhost:4010
export GITHUB_API_URL=$MOCK/api GITHUB_WEB_URL=$MOCK GITHUB_APP_ID=1 GITHUB_APP_SLUG=autodev-e2e \
  GITHUB_APP_CLIENT_ID=Iv1.e2e GITHUB_APP_CLIENT_SECRET=e2e-secret GITHUB_APP_PRIVATE_KEY=unused-in-e2e \
  GITHUB_WEBHOOK_SECRET=e2e-webhook-secret-123 LOG_LEVEL=warn
# The mock only scripts the agent's phases. Set REAL_ANTHROPIC=1 to call the real API with your own key.
if [ -z "${REAL_ANTHROPIC:-}" ]; then export ANTHROPIC_BASE_URL=$MOCK/anthropic; fi
# The Group Agent's dependency scan asks the mock instead of OSV.dev and the public registries.
export OSV_API_URL=$MOCK/osv NPM_REGISTRY_URL=$MOCK/npm PYPI_URL=$MOCK/pypi GOPROXY_URL=$MOCK/goproxy

LOGS="$ROOT/tools/demo/logs"; mkdir -p "$LOGS"
PIDS=()
cleanup() { echo; echo "Stopping…"; kill "${PIDS[@]}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$SHIM"; }
trap cleanup EXIT INT TERM

echo "==> Database and demo data"
if ! (echo > /dev/tcp/localhost/5433) 2>/dev/null || ! (echo > /dev/tcp/localhost/6379) 2>/dev/null; then
  if docker compose version >/dev/null 2>&1; then docker compose up -d >/dev/null; else docker-compose up -d >/dev/null; fi
fi
$PNPM db:migrate >/dev/null
$PNPM --filter @autodev/db seed >/dev/null

echo "==> Demo repo fixture and runner CLI"
(cd packages/db && ./node_modules/.bin/tsx ../../tools/demo/fixture.ts) >/dev/null

echo "==> Starting services (logs in $LOGS)"
MOCK_GITHUB_PORT=4010 MOCK_REPO_DIR="$ROOT/tools/e2e/.fixture/acme-web" $PNPM --filter @autodev/mock-github start >"$LOGS/mock.log" 2>&1 & PIDS+=($!)
$PNPM --filter @autodev/worker dev >"$LOGS/worker.log" 2>&1 & PIDS+=($!)
$PNPM --filter @autodev/builder-gateway dev >"$LOGS/gateway.log" 2>&1 & PIDS+=($!)
$PNPM --filter @autodev/api dev >"$LOGS/api.log" 2>&1 & PIDS+=($!)
$PNPM --filter @autodev/web dev >"$LOGS/web.log" 2>&1 & PIDS+=($!)

wait_for() {
  for _ in $(seq 1 180); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  return 1
}
wait_for http://localhost:4000/healthz
wait_for http://localhost:3000/login

cat <<MSG

Ready.
  Open:    http://localhost:4010/_login-as?login=demo-owner   (signs you in as the demo owner)
           then http://localhost:3000/o/acme-demo/repos
  Other demo users: demo-dev (developer), demo-viewer (read-only, if seeded)
  Pages:   board  /o/acme-demo/repos/api      chat  /o/acme-demo/repos/web/chat
           new task  /o/acme-demo/repos/web/new      models  /o/acme-demo/settings/models
  Stop:    Ctrl+C

MSG
wait
