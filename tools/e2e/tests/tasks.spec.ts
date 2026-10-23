import { expect, test, type Page } from '@playwright/test';

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

test('the board groups seeded tasks into columns', async ({ page }) => {
  await signInAs(page, 'demo-owner');
  await page.getByRole('link', { name: 'acme-demo/api' }).click();
  await expect(page.getByRole('heading', { name: 'acme-demo/api' })).toBeVisible();
  await expect(page.getByTestId('column-needs_you')).toContainText('Return 404 instead of 500');
  await expect(page.getByTestId('column-in_progress')).toContainText('Migrate session store to Redis');
  await expect(page.getByTestId('column-pr')).toContainText('Paginate the audit log');
  await page.screenshot({ path: 'test-results/board.png', fullPage: true });
});

test('a developer creates a follow-up task on an existing branch; starting needs a working LLM key', async ({ page }) => {
  await signInAs(page, 'demo-dev');
  await page.goto('/o/acme-demo/repos/web');
  await page.getByRole('link', { name: 'New task' }).click();

  await page.getByLabel('Title').fill('Keep the return URL after SSO login');
  await page.getByLabel('Acceptance criteria').fill('- Users land on the page they asked for');
  await page.getByLabel('Continue on an existing branch').check();
  await page.getByLabel('Branch', { exact: true }).selectOption('feature/sso-login');
  await page.getByText('More options').click();
  await page.getByLabel('Limit to folder (optional)').fill('./apps/web/');
  await page.getByRole('button', { name: 'Save as draft' }).click();

  // The first visit compiles the task page in Next dev.
  await expect(page).toHaveURL(/\/o\/acme-demo\/tasks\/AD-\d+/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Keep the return URL after SSO login' })).toBeVisible();
  await expect(page.getByText('feature/sso-login').first()).toBeVisible();
  await expect(page.getByText('apps/web', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('No working LLM key is configured for this organization.')).toBeVisible();

  // Cancel so reruns against the same dev DB stay tidy.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
});

test('a viewer can browse tasks but not create them', async ({ page }) => {
  await page.goto('http://localhost:4010/_login-as?login=demo-viewer');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  // The first visit compiles the page in Next dev.
  await expect(page.getByText('Add rate limiting to the public API')).toBeVisible({ timeout: 30_000 });
  await page.goto('/o/acme-demo/repos/api');
  await expect(page.getByRole('heading', { name: 'acme-demo/api' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New task' })).toHaveCount(0);
});
