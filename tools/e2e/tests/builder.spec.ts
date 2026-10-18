import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_DIR } from '../global-setup';

test.setTimeout(240_000);
const API = 'http://localhost:4000';

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

let runner: ChildProcess | null = null;
const runnerOutput: string[] = [];
test.afterEach(() => {
  runner?.kill('SIGTERM');
  runner = null;
});

test('pair a builder, run the agent, approve the first run, and the real runner passes the tests in Docker', async ({ page, request }) => {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'demo-owner');

  // A working LLM key (removing leftovers from aborted runs).
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByRole('heading', { name: 'AI keys' })).toBeVisible();
  while (await page.getByRole('button', { name: 'Remove' }).count()) {
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.waitForTimeout(500);
  }
  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-builder-000-BLDR');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••BLDR')).toBeVisible();

  // Leftover builders from aborted runs.
  await page.goto('/o/acme-demo/builders');
  await expect(page.getByRole('heading', { name: 'Builders' })).toBeVisible();
  await page.waitForTimeout(1000);
  while (await page.getByRole('button', { name: 'Revoke' }).count()) {
    await page.getByRole('button', { name: 'Revoke' }).first().click();
    await page.waitForTimeout(800);
  }

  // 1. Pair: what `autodev login` does, approved in the dashboard.
  const start = await (await request.post(`${API}/builder/pair/start`, { data: { name: 'E2E laptop' } })).json();
  await page.goto(`/builders/pair?code=${start.userCode}`);
  await page.getByRole('button', { name: 'Approve this builder' }).click();
  await expect(page.getByRole('heading', { name: 'Builder paired' })).toBeVisible();
  const paired = await (await request.post(`${API}/builder/pair/poll`, { data: { deviceCode: start.deviceCode } })).json();
  expect(paired.status).toBe('approved');

  // 2. Bind the fixture clone and start the real CLI (Docker mode).
  const bind = await request.post(`${API}/builder/bindings`, { data: { repoFullName: 'acme-demo/web', localPath: FIXTURE_DIR }, headers: { authorization: `Bearer ${paired.token}` } });
  expect(bind.ok()).toBe(true);
  const home = mkdtempSync(join(tmpdir(), 'autodev-e2e-home-'));
  writeFileSync(join(home, 'builder.json'), JSON.stringify({ apiUrl: API, gatewayUrl: paired.gatewayUrl, builderId: paired.builderId, orgSlug: paired.orgSlug, token: paired.token }), { mode: 0o600 });
  runner = spawn(process.execPath, ['../../apps/runner-cli/dist/cli.js', 'start'], { env: { ...process.env, AUTODEV_HOME: home, AUTODEV_CACHE: join(home, 'cache') }, stdio: 'pipe' });
  runner.stdout!.on('data', (d) => runnerOutput.push(String(d)));
  runner.stderr!.on('data', (d) => runnerOutput.push(String(d)));

  await page.goto('/o/acme-demo/builders');
  await expect(page.getByRole('heading', { name: 'E2E laptop', exact: true })).toBeVisible();
  await expect(page.getByText(/^● ?Online$/), `runner output:\n${runnerOutput.join('')}`).toBeVisible({ timeout: 20_000 });

  // 3. A direct-mode task: the agent codes and finishes; the job waits for first-run approval.
  await page.goto('/o/acme-demo/repos/web/new');
  await page.getByLabel('Title').fill('Say hello (builder e2e)');
  await page.getByLabel('Workflow').selectOption('direct');
  await page.getByRole('button', { name: 'Create and start' }).click();
  await expect(page).toHaveURL(/\/tasks\/AD-\d+/, { timeout: 20_000 });
  const taskUrl = page.url();
  await expect(page.getByText('needs your OK for its first run')).toBeVisible({ timeout: 60_000 });

  // 4. Approve the exact commands on the Builders page.
  await page.getByRole('link', { name: 'Review the commands' }).click();
  await expect(page.getByText('$ grep -q hello src/app.ts && echo "1 passed"')).toBeVisible();
  await page.getByRole('button', { name: 'Allow these commands for acme-demo/web' }).click();

  // 5. The runner picks the job up, runs it in Docker, and the result comes back.
  await page.goto(taskUrl);
  await expect(page.getByText('✓ Passed'), `runner output:\n${runnerOutput.join('')}`).toBeVisible({ timeout: 150_000 });
  await page.getByRole('button', { name: 'Show log' }).click();
  await expect(page.getByText('1 passed').first()).toBeVisible();
  await expect(page.getByText(/Running in Docker \(alpine:3\.20\)/)).toBeVisible();
  await page.screenshot({ path: 'test-results/builder-task.png', fullPage: true });
  expect(runnerOutput.join('')).toMatch(/passed in \d+s/);

  // Cleanup for reruns.
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await page.goto('/o/acme-demo/builders');
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('heading', { name: 'E2E laptop', exact: true })).toHaveCount(0);
  await page.goto('/o/acme-demo/settings/ai-keys');
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.getByText('No keys yet.')).toBeVisible();
});
