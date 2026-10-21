import { expect, test, type Page } from '@playwright/test';

test.setTimeout(120_000);

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

const indexToggle = (page: Page) => page.getByLabel('Store a searchable index of our code');

async function setIndex(page: Page, on: boolean) {
  await page.goto('/o/acme-demo/settings');
  const box = indexToggle(page);
  await expect(box).toBeVisible();
  if ((await box.isChecked()) !== on) {
    await box.click();
    await expect(box).toBeChecked({ checked: on });
  }
}

async function removeKeys(page: Page) {
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByText(/Your tasks use|No working key yet/)).toBeVisible();
  while (await page.getByRole('button', { name: 'Remove' }).count()) {
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.waitForTimeout(500);
  }
}

// Other specs expect the index off and no key, so both go even when the test fails.
// The test's own dialog handler (accept) still applies here.
test.afterEach(async ({ page }) => {
  await setIndex(page, false);
  await removeKeys(page);
});

async function ask(page: Page, question: string) {
  // The first "New chat" is the button; the rest are untitled chats in the list.
  const before = page.url();
  await page.getByRole('button', { name: 'New chat' }).first().click();
  // Wait for the new chat to open, or the question lands in the one shown before.
  await page.waitForURL((u) => u.toString() !== before && u.searchParams.has('c'));
  await page.getByLabel('Your question').fill(question);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
}

test('an admin turns on the code index; the worker builds it; chat search uses it; turning it off deletes it', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'demo-owner');
  await removeKeys(page);
  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-index-0000-INDX');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••INDX')).toBeVisible();

  // Off by default: chat searches GitHub.
  await page.goto('/o/acme-demo/repos/web/chat');
  const status = page.getByLabel('Code index');
  await expect(status).toContainText('Search uses GitHub code search', { timeout: 30_000 });
  await ask(page, 'Where is the greeting made? (before)');
  await expect(page.getByText('Found with GitHub search')).toBeVisible({ timeout: 30_000 });

  // On: the worker reads the repo with the installation token and indexes it; the status updates live.
  await setIndex(page, true);
  await page.goto('/o/acme-demo/repos/web/chat');
  await expect(status).toContainText(/Code index: \d+ files at [0-9a-f]{7}/, { timeout: 60_000 });
  await ask(page, 'Where is the greeting made? (after)');
  await expect(page.getByText('Found with the code index')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'src/app.ts:1' }).last()).toBeVisible();

  // Off: the index is deleted and chat goes back to GitHub search.
  await setIndex(page, false);
  await page.goto('/o/acme-demo/repos/web/chat');
  await expect(status).toContainText('Search uses GitHub code search', { timeout: 30_000 });
});
