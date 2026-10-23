import { expect, test } from '@playwright/test';

test.setTimeout(90_000);

test('an owner sees the setup checklist, and the billing page says billing is off without Stripe', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('http://localhost:4010/_login-as?login=demo-owner');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });

  await page.goto('/o/acme-demo/onboarding');
  await expect(page.getByRole('heading', { name: 'Set up AutoDev' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toBeVisible();
  // The App is installed for the demo org; billing is off, so there's no plan step.
  await expect(page.getByText('Install the GitHub App (done)')).toBeAttached();
  await expect(page.getByText('Choose a plan', { exact: true })).toHaveCount(0);
  for (const step of ['Add an AI key', 'Check the models', 'Bring your team', 'Pair a builder']) await expect(page.getByText(step, { exact: false }).first()).toBeVisible();

  await page.goto('/o/acme-demo/settings/billing');
  await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Billing isn’t set up on this server')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Billing' })).toHaveAttribute('class', /font-medium/);
});
