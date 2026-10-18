import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
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

test('pair a builder → agent codes → first-run approval → real Docker test run → push → PR → merge resolves', async ({ page, request }) => {
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

  // 6. Push and PR: the change lands on autodev/<KEY>-<slug> and the PR is opened, as the owner.
  await expect(page.getByRole('link', { name: /Open PR #\d+ on GitHub/ })).toBeVisible({ timeout: 30_000 });
  const key = /\/tasks\/(AD-\d+)/.exec(taskUrl)![1]!;
  const branch = `autodev/${key}-say-hello-builder-e2e`;
  const mock = await (await request.get(`http://localhost:4010/_mock/pulls?branch=${encodeURIComponent(branch)}`)).json();
  expect(mock.files['src/app.ts']).toBe('export const greet = () => "hello";\n');
  const pr = mock.pulls.find((p: { head: string }) => p.head === branch);
  expect(pr).toMatchObject({ base: 'main', title: `${key}: Say hello (builder e2e)`, author: 'demo-owner' });
  for (const section of ['## Summary', '## Task', '## Approved Plan', '## Approved LLD', '## Changes', '## Testing', '## AI usage']) expect(pr.body).toContain(section);
  expect(pr.body).toContain('✅ Passed on **E2E laptop** (Docker, `alpine:3.20`)');
  expect(pr.body).toContain('direct mode (no approval steps)');
  await page.screenshot({ path: 'test-results/builder-task.png', fullPage: true });

  // 7. GitHub reports the merge: the task is resolved.
  const payload = JSON.stringify({
    action: 'closed',
    installation: { id: 900_200 },
    repository: { id: 900_300 },
    sender: { id: 900_001 },
    pull_request: { id: pr.id, number: pr.number, html_url: `https://github.com/acme-demo/web/pull/${pr.number}`, merged: true, head: { ref: branch, sha: 'x' }, base: { ref: 'main' } },
  });
  const hook = await request.post(`${API}/webhooks/github`, {
    data: payload,
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'e2e-webhook-secret-123').update(payload).digest('hex') },
  });
  expect(await hook.json()).toEqual({ result: 'pr:merged' });
  await page.reload();
  await expect(page.getByText(`Pull request #${pr.number} is merged, so this task is resolved.`)).toBeVisible();
  await expect(page.getByText('Resolved').first()).toBeVisible();

  // Cleanup for reruns.
  await page.goto('/o/acme-demo/builders');
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByRole('heading', { name: 'E2E laptop', exact: true })).toHaveCount(0);
  await page.goto('/o/acme-demo/settings/ai-keys');
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.getByText('No keys yet.')).toBeVisible();
});
