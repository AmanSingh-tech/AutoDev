import { expect, test, type Page } from '@playwright/test';

test.setTimeout(180_000);

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

test('plan → request changes → plan v2 → approve → design → approve → code, end to end through the worker', async ({ page }) => {
  await signInAs(page, 'demo-owner');
  // Collected after sign-in: Next.js logs its own fallback when a server action redirects to the
  // external OAuth page, which is expected and not part of what's tested here.
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  // A working org key (validated against the mock). Leftovers from an aborted run are removed first.
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByRole('heading', { name: 'AI keys' })).toBeVisible();
  page.on('dialog', (d) => d.accept());
  while (await page.getByRole('button', { name: 'Remove' }).count()) {
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.waitForTimeout(500);
  }
  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-agent-0000-AGNT');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••AGNT')).toBeVisible();

  // Create and start a plan → design → code task.
  await page.goto('/o/acme-demo/repos/web/new');
  await page.getByLabel('Title').fill('Say hello instead of hi');
  await page.getByLabel('Acceptance criteria').fill('- greet() returns "hello"');
  await page.getByRole('button', { name: 'Create and start' }).click();
  await expect(page).toHaveURL(/\/tasks\/AD-\d+/, { timeout: 20_000 });

  // The worker plans; the plan appears for review.
  await expect(page.getByRole('heading', { name: 'Plan v1 is ready for your review' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('region', { name: 'Plan review' }).getByRole('heading', { name: 'Files to change' })).toBeVisible();
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.getByLabel('What should change?').fill('Also handle empty names');
  await page.getByRole('button', { name: 'Send to the agent for v2' }).click();

  await expect(page.getByRole('heading', { name: 'Plan v2 is ready for your review' })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('and handle empty names').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve plan' }).click();

  await expect(page.getByRole('heading', { name: 'Low-level design v1 is ready for your review' })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Approve design' }).click();

  // Coding finishes and waits for the (A-5) builder; the change is visible as a diff.
  await expect(page.getByText(/Waiting for your builder/).first()).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: /src\/app\.ts/ }).click();
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/agent-task.png', fullPage: true });

  // Version history keeps v1 with its review comment.
  await page.getByRole('combobox', { name: 'Version' }).selectOption('1');
  await expect(page.getByText('Also handle empty names').first()).toBeVisible();

  expect(consoleErrors).toEqual([]);

  // Cleanup for reruns: cancel the task and remove the key.
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await page.goto('/o/acme-demo/settings/ai-keys');
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.getByText('No keys yet.')).toBeVisible();
});
