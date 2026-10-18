import { defineConfig, devices } from '@playwright/test';

const MOCK = 'http://localhost:4010';

/** The API and web app talk to tools/mock-github instead of GitHub. Uses the dev DB with the demo seed. */
const githubEnv = {
  GITHUB_API_URL: `${MOCK}/api`,
  GITHUB_WEB_URL: MOCK,
  GITHUB_APP_ID: '1',
  GITHUB_APP_SLUG: 'autodev-e2e',
  GITHUB_APP_CLIENT_ID: 'Iv1.e2e',
  GITHUB_APP_CLIENT_SECRET: 'e2e-secret',
  GITHUB_APP_PRIVATE_KEY: 'unused-in-e2e',
  GITHUB_WEBHOOK_SECRET: 'e2e-webhook-secret-123',
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @autodev/mock-github start',
      // Unauthenticated /api/user answers 401, which Playwright counts as up.
      url: `${MOCK}/api/user`,
      reuseExistingServer: false,
      env: { MOCK_GITHUB_PORT: '4010' },
    },
    {
      command: 'pnpm --filter @autodev/db seed && pnpm --filter @autodev/api dev',
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
