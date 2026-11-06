import { expect, test } from '@playwright/test';

test.setTimeout(420_000);

test('autopilot: queue a task, run until morning, and the agent hands back a draft PR to mark ready', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('http://localhost:4010/_login-as?login=demo-trial');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/orgs|\/o\//, { timeout: 30_000 });

  await page.goto('/demo');
  await expect(page).toHaveURL(/\/o\/demo-demo-trial-[0-9a-f]{4}$/, { timeout: 60_000 });
  const slug = new URL(page.url()).pathname.split('/')[2];

  // A new draft task, queued for Autopilot from its page.
  await page.goto(`/o/${slug}/repos/web/new`);
  const title = `Add an empty state to the invoices list ${Date.now().toString(36)}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Acceptance criteria').fill('- Shows a message when there are no invoices');
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Run on Autopilot' }).click();
  await expect(page.getByText('Queued for Autopilot')).toBeVisible();

  // Start a session now instead of waiting for tonight.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Autopilot' }).click();
  await expect(page.getByRole('heading', { name: 'Tonight’s queue' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  if (await page.getByRole('button', { name: 'Run until morning' }).isVisible()) await page.getByRole('button', { name: 'Run until morning' }).click();
  await expect(page.getByRole('button', { name: 'Stop now' })).toBeVisible({ timeout: 30_000 });

  // The scheduler picks it up (every 2 minutes); the agent plans, Autopilot approves, it codes and tests.
  const card = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title }) }).filter({ hasText: 'draft' });
  await expect(card).toBeVisible({ timeout: 300_000 });
  await card.getByRole('button', { name: 'Ready for review' }).click();
  await expect(page.getByText(/: ready for review/)).toBeVisible();

  // Its plan was approved by Autopilot, not a person.
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByText('Approved by Autopilot').first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/o/${slug}/autopilot`);
  await page.getByRole('button', { name: 'Stop now' }).click();
});
