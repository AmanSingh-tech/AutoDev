import { expect, test, type Page } from '@playwright/test';

test.setTimeout(120_000);

async function removeAll(page: Page, button: string) {
  while (await page.getByRole('button', { name: button }).count()) {
    await page.getByRole('button', { name: button }).first().click();
    await page.waitForTimeout(500);
  }
}

/** Org templates sit in collapsed rows; open each copy and delete it. */
async function removeCopies(page: Page) {
  const row = page.locator('summary', { hasText: 'Bug fix (copy)' });
  while (await row.count()) {
    await row.first().click();
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.waitForTimeout(500);
  }
}

// Leaves no key or template behind, even when the test fails: other specs expect the org to have no key.
test.afterEach(async ({ page }) => {
  // The test accepts confirm dialogs (registered before anything can fail).
  await page.goto('/o/acme-demo/settings/templates');
  await expect(page.getByRole('heading', { name: 'Task templates' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('summary', { hasText: /^Bug fix$/ })).toBeVisible();
  await removeCopies(page);
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByRole('heading', { name: 'AI keys' })).toBeVisible();
  await expect(page.getByText(/Your tasks use|No working key yet/)).toBeVisible();
  await removeAll(page, 'Remove');
  await expect(page.getByText('No working key yet')).toBeVisible();
});

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

test('templates, the live score, check deeper and a rewrite that can be undone; the score is saved on the task', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'demo-owner');

  // A working org key, for the model calls. Leftovers from an aborted run are removed first.
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByRole('heading', { name: 'AI keys' })).toBeVisible();
  await expect(page.getByText(/Your tasks use|No working key yet/)).toBeVisible();
  await removeAll(page, 'Remove');
  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-prompt-000-PRMT');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••PRMT')).toBeVisible();

  // An org template, copied from a built-in one.
  await page.getByRole('link', { name: 'Task templates' }).click();
  await expect(page.getByRole('heading', { name: 'Task templates' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('summary', { hasText: /^Bug fix$/ })).toBeVisible();
  await removeCopies(page);
  await page.locator('summary', { hasText: /^Bug fix$/ }).click();
  await page.getByRole('button', { name: 'Copy to your templates' }).click();
  await expect(page.getByLabel('Name')).toHaveValue('Bug fix (copy)');
  await page.getByRole('button', { name: 'Add template' }).click();
  await expect(page.getByText('Bug fix (copy)')).toBeVisible();

  // The new-task form: the score updates while typing.
  await page.goto('/o/acme-demo/repos/web/new');
  const guide = page.getByRole('region', { name: 'Prompt guide' });
  await page.getByLabel('Title').fill('Fix greeting');
  await expect(guide.getByText('Looks like a bug, but there are no steps')).toBeVisible();
  await expect(guide.getByTitle(/Prompt score \d+ of 100/)).toHaveText('10/100');

  // The org's template fills in the fields; its placeholders are flagged.
  await page.getByLabel('Start from a template (optional)').selectOption({ label: 'Bug fix (copy)' });
  await expect(page.getByLabel('Description')).toHaveValue(/## Steps to reproduce/);
  await expect(guide.getByText('Some [TODO: …] placeholders are still empty.')).toBeVisible();

  // A deeper check from the model.
  await guide.getByRole('button', { name: 'Check deeper' }).click();
  await expect(guide.getByText('The draft needs steps to reproduce.')).toBeVisible();

  // Rewrite, undo, rewrite again.
  await guide.getByRole('button', { name: 'Rewrite' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Fix greet() returning the wrong word');
  await expect(guide.getByTitle(/Prompt score/).first()).toHaveText('100/100');
  // Undo lives in the toast that confirms the rewrite.
  const toast = page.getByRole('listitem').filter({ hasText: 'Draft rewritten' });
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Fix greeting');
  await guide.getByRole('button', { name: 'Rewrite' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('Fix greet() returning the wrong word');

  await page.getByRole('button', { name: 'Save as draft' }).click();
  // The first visit compiles the task page in Next dev.
  await expect(page).toHaveURL(/\/o\/acme-demo\/tasks\/AD-\d+/, { timeout: 30_000 });
  await expect(page.getByText('Prompt score', { exact: true })).toBeVisible();
  await expect(page.getByTitle(/Prompt score 100 of 100/)).toBeVisible();

  // Tidy up so reruns against the same dev DB start clean.
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
  // The template and key are removed in afterEach.
});
