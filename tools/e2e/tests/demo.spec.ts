import { expect, test } from '@playwright/test';

test.setTimeout(150_000);

test('try the demo: a sample org opens, and the simulated agent takes an approved plan through design, code, tests and a PR', async ({ page }) => {
  await page.context().clearCookies();
  // demo-trial is in no GitHub org, so only its own demo org changes between runs.
  await page.goto('http://localhost:4010/_login-as?login=demo-trial');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/orgs/, { timeout: 30_000 });

  await page.goto('/demo');
  await expect(page).toHaveURL(/\/o\/demo-demo-trial-[0-9a-f]{4}$/, { timeout: 60_000 });
  await expect(page.getByText('Demo organization.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible();
  const slug = new URL(page.url()).pathname.split('/')[2];

  // A new task each run (the demo org is reused), through the repo picker.
  await page.getByRole('link', { name: 'New task' }).first().click();
  await page.getByRole('link', { name: 'acme/api' }).click();
  const title = `Health check for the billing service ${Date.now().toString(36)}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Acceptance criteria').fill('- GET /health returns 200');
  await page.getByRole('button', { name: 'Create and start' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${slug}/tasks/ACME-\\d+$`), { timeout: 30_000 });

  // The simulated agent plans (a few seconds of visible steps), then waits for approval.
  await expect(page.getByRole('button', { name: 'Approve plan' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByRole('button', { name: 'Approve design' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve design' }).click();

  // Code, a passing test run and the pull request, then a demo merge.
  await expect(page.getByRole('button', { name: 'Merge (demo)' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Merge (demo)' }).click();
  await expect(page.getByText('Pull request merged (demo)')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Progress' }).getByText('Pull request')).toBeVisible();
});
