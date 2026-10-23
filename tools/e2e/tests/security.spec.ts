import { expect, test } from '@playwright/test';

test.setTimeout(90_000);

test('an owner sets retention, sees their address for the allowlist, and downloads the audit log', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('http://localhost:4010/_login-as?login=demo-owner');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });

  await page.goto('/o/acme-demo/settings/security');
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible({ timeout: 30_000 });

  const chat = page.getByLabel('Repo chat and team rooms');
  await chat.fill('30');
  await page.getByRole('button', { name: 'Save retention' }).click();
  await expect(page.getByText('Retention saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Repo chat and team rooms')).toHaveValue('30', { timeout: 30_000 });
  // Back to "keep forever" for other runs.
  await page.getByLabel('Repo chat and team rooms').fill('');
  await page.getByRole('button', { name: 'Save retention' }).click();
  await expect(page.getByText('Retention saved')).toBeVisible();

  // A list without your own address is refused.
  await page.getByLabel('Allowed networks').fill('203.0.113.0/24');
  await page.getByRole('button', { name: 'Save allowlist' }).click();
  await expect(page.getByText(/must include your own address/)).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/);
});
