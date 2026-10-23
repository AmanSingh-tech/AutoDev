import { expect, test, type Page } from '@playwright/test';

test.setTimeout(180_000);

async function signInAs(page: Page, login: string) {
  await page.context().clearCookies();
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

test('the Group Agent scans the repos, finds a vulnerable lodash, and the recommendation becomes a task', async ({ page }) => {
  page.on('dialog', (d) => d.accept());

  // Admins only.
  await signInAs(page, 'demo-dev');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Group Agent' })).toHaveCount(0);

  await signInAs(page, 'demo-owner');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Group Agent' }).click();
  await expect(page.getByRole('heading', { name: 'Group Agent', exact: true })).toBeVisible({ timeout: 30_000 });

  // Scan: the worker reads the lockfile with the installation token and asks the mock OSV.
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByText('Scanning.')).toBeVisible();
  // Every demo repo shares the fixture's lockfile; any repo whose recommendation is open will do.
  const lodash = page.getByRole('heading', { name: /^Upgrade lodash to 4\.17\.21 in acme-demo\// });
  await expect(async () => {
    await page.reload();
    await expect(lodash.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  const title = (await lodash.first().textContent())!;
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card.getByText(/High$/).first()).toBeVisible();
  await expect(card.getByText(/CVE-2021-23337/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Repository health' })).toBeVisible();

  // One click to a draft task.
  await card.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByText(/^Created [A-Z]+-\d+$/)).toBeVisible();
  await page.locator('[data-sonner-toast]').filter({ hasText: /^Created/ }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Draft').first()).toBeVisible();

  // Dropping the task lets the recommendation be reopened, which also leaves reruns where they started.
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  await page.goto('/o/acme-demo/group-agent');
  await page.getByRole('tab', { name: 'Became tasks' }).click();
  await page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: 'Reopen' }).click();
  await page.getByRole('tab', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

  // The digest and the settings.
  await page.getByRole('link', { name: 'Weekly digest' }).click();
  await expect(page.getByRole('heading', { name: 'Weekly digest' })).toBeVisible({ timeout: 30_000 });
  await page.goto('/o/acme-demo/settings/group-agent');
  await expect(page.getByLabel('Safety level for acme-demo/web')).toHaveValue('2', { timeout: 30_000 });
});
