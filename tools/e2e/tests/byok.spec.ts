import { expect, test, type Page } from '@playwright/test';

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

test('an owner adds the company LLM key; it is checked first and shown only by its last 4 characters', async ({ page }) => {
  await signInAs(page, 'demo-owner');
  await page.goto('/o/acme-demo/settings/ai-keys');

  await page.getByLabel('Name').fill('Company key');
  await page.getByLabel('Anthropic API key').fill('sk-ant-bad-000000000000000000');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('The provider rejected this key.')).toBeVisible();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('');

  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-000000000-K3Y9');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••K3Y9')).toBeVisible();
  await expect(page.getByText(/Your tasks use the organization key ending in/)).toBeVisible();
  await expect(page.getByText('sk-ant-good-e2e')).toHaveCount(0);

  // Clean up so the test can run again against the same dev database.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.getByText('No keys yet.')).toBeVisible();
});

test('the owner sees org usage and the budget meter', async ({ page }) => {
  await signInAs(page, 'demo-owner');
  await page.getByRole('link', { name: 'Usage' }).click();
  // The first visit compiles the page in Next dev.
  await expect(page.getByRole('heading', { name: 'AI usage' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Usage across the organization.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily cost (UTC)' })).toBeVisible();
  await page.screenshot({ path: 'test-results/usage.png', fullPage: true });

  await page.goto('/o/acme-demo/settings/budgets');
  await expect(page.getByRole('meter', { name: 'This month budget' })).toBeVisible();
  await page.screenshot({ path: 'test-results/budgets.png', fullPage: true });
});

test('a developer sees only their own usage and cannot add org keys', async ({ page }) => {
  await signInAs(page, 'demo-dev');
  await page.goto('/o/acme-demo/usage');
  await expect(page.getByText('Your usage.')).toBeVisible();
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByLabel('Applies to')).toHaveValue('user');
  await expect(page.getByLabel('Applies to').locator('option')).toHaveCount(1);
});
