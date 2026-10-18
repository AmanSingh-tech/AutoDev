import { expect, test } from '@playwright/test';

test('a developer signs in with GitHub and sees only repos they can push to', async ({ page }) => {
  await page.goto('http://localhost:4010/_login-as?login=demo-dev');
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();

  // demo-dev belongs to one org, so the picker jumps straight to its repos.
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();

  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole('cell', { name: 'acme-demo/api' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'acme-demo/infra' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'acme-demo/web' })).toBeVisible();
  // Read-only on GitHub, so it must not be listed.
  await expect(page.getByRole('cell', { name: 'acme-demo/docs' })).toHaveCount(0);
});

test('a developer can view settings but not change them', async ({ page }) => {
  await page.goto('http://localhost:4010/_login-as?login=demo-dev');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText('Only admins can change these settings.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});
