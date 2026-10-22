import { expect, test, type Page } from '@playwright/test';

test.setTimeout(150_000);

/** Signs in as `login`, signing out whoever was signed in first (this test switches users). */
async function signInAs(page: Page, login: string) {
  await page.context().clearCookies();
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

/** Back to the private defaults, so other runs and specs start from them. */
async function resetSettings(page: Page) {
  await signInAs(page, 'demo-owner');
  await page.goto('/o/acme-demo/settings/insights');
  await page.getByLabel('Admins only').check({ timeout: 30_000 });
  await page.getByLabel('Hide cost from non-admins').check();
  await page.getByLabel('Show badges').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Insights settings saved')).toBeVisible();
}

test.afterEach(async ({ page }) => {
  await resetSettings(page);
});

test('an admin rebuilds insights and sees the dashboard; the leaderboard opens to developers only when allowed, without cost', async ({ page }) => {
  // A developer sees no Insights by default.
  await signInAs(page, 'demo-dev');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Insights' })).toHaveCount(0);
  await page.goto('/o/acme-demo/insights/leaderboard');
  await expect(page.getByText('Only admins can see the leaderboard in this organization.')).toBeVisible({ timeout: 30_000 });

  // The admin rebuilds the figures; the worker runs the job.
  await resetSettings(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Recompute now' }).click();
  await expect(page.getByText('Recomputing.')).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Rebuilt nightly; last/)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText('Cost per merged PR')).toBeVisible();
  await expect(page.getByText('First-pass approval')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Spend by model' })).toBeVisible();
  await page.getByRole('tab', { name: 'Repositories' }).click();
  await expect(page.getByRole('cell', { name: 'acme-demo/api' })).toBeVisible();
  await page.screenshot({ path: 'test-results/insights.png', fullPage: true });

  // Open the leaderboard to everyone (cost stays hidden from non-admins).
  await page.goto('/o/acme-demo/settings/insights');
  await page.getByLabel('Everyone in the organization').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Insights settings saved')).toBeVisible();

  await signInAs(page, 'demo-dev');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Period', { exact: true }).selectOption('quarter');
  // The seeded org has merged work this quarter, so the board has rows; cost columns stay hidden.
  await expect(page.getByRole('table')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('(you)')).toBeVisible();
  await page.screenshot({ path: 'test-results/leaderboard.png', fullPage: true });
  await expect(page.getByText('Cost per PR', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tokens' }).click();
  await expect(page.locator('th', { hasText: /^Tokens$/ })).toBeVisible();
  await expect(page.locator('th', { hasText: /^Cost$/ })).toHaveCount(0);
});
