import { defineConfig, devices } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { FIXTURE_DIR } from './global-setup';

const MOCK = 'http://localhost:4010';

/** A throwaway App key: background jobs sign a JWT with it to get an installation token from the mock. */
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

/** The API and web app talk to tools/mock-github instead of GitHub. Uses the dev DB with the demo seed. */
const githubEnv = {
  GITHUB_API_URL: `${MOCK}/api`,
  GITHUB_WEB_URL: MOCK,
  GITHUB_APP_ID: '1',
  GITHUB_APP_SLUG: 'autodev-e2e',
  GITHUB_APP_CLIENT_ID: 'Iv1.e2e',
  GITHUB_APP_CLIENT_SECRET: 'e2e-secret',
  GITHUB_APP_PRIVATE_KEY: appKey.replace(/\n/g, '\\n'),
  GITHUB_WEBHOOK_SECRET: 'e2e-webhook-secret-123',
  ANTHROPIC_BASE_URL: `${MOCK}/anthropic`,
  // The seed keeps the demo budget warning-only, so usage from earlier runs never blocks AI calls.
  SEED_SOFT_BUDGET: '1',
  OSV_API_URL: `${MOCK}/osv`,
  NPM_REGISTRY_URL: `${MOCK}/npm`,
  PYPI_URL: `${MOCK}/pypi`,
  GOPROXY_URL: `${MOCK}/goproxy`,
  LOG_LEVEL: 'warn',
  // The code index uses a stand-in embedder, so no model is downloaded.
  EMBEDDINGS_PROVIDER: 'fake',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @autodev/mock-github start',
      // Unauthenticated /api/user answers 401, which Playwright counts as up.
      url: `${MOCK}/api/user`,
      reuseExistingServer: false,
      env: { MOCK_GITHUB_PORT: '4010', MOCK_REPO_DIR: FIXTURE_DIR },
    },
    {
      // The worker has no HTTP port, so it starts alongside the API.
      command: "pnpm --filter @autodev/db seed && sh -c 'pnpm --filter @autodev/worker dev & pnpm --filter @autodev/builder-gateway dev & pnpm --filter @autodev/api dev'",
      url: 'http://localhost:4000/healthz',
      reuseExistingServer: false,
      timeout: 60_000,
      env: githubEnv,
    },
    {
      command: 'pnpm --filter @autodev/web dev',
      url: 'http://localhost:3000/login',
      reuseExistingServer: false,
      timeout: 180_000,
      env: githubEnv,
    },
  ],
});
