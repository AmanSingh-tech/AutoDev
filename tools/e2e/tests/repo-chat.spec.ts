import { expect, test, type Page } from '@playwright/test';

test.setTimeout(120_000);

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

async function removeKeys(page: Page) {
  await page.goto('/o/acme-demo/settings/ai-keys');
  await expect(page.getByRole('heading', { name: 'AI keys' })).toBeVisible();
  // The key list loads after the heading; counting buttons before then would find none.
  await expect(page.getByText(/Your tasks use|No working key yet/)).toBeVisible();
  while (await page.getByRole('button', { name: 'Remove' }).count()) {
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await page.waitForTimeout(500);
  }
}

// Other specs expect the org to have no key, so it goes even when the test fails.
test.afterEach(async ({ page }) => {
  await removeKeys(page);
  await expect(page.getByText('No working key yet')).toBeVisible();
});

test('team room: @agent answers with a cited line on GitHub, the answer becomes a task, and the memory is editable', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'demo-owner');
  await removeKeys(page);
  await page.getByLabel('Anthropic API key').fill('sk-ant-good-e2e-room-0000-ROOM');
  await page.getByRole('button', { name: 'Check and save' }).click();
  await expect(page.getByText('••••ROOM')).toBeVisible();

  // The room, from the repo's tabs.
  await page.goto('/o/acme-demo/repos/web');
  await page.getByRole('navigation', { name: 'Repository' }).getByRole('link', { name: 'Team room' }).click();
  await expect(page.getByRole('heading', { name: 'Team room' })).toBeVisible({ timeout: 30_000 });

  const question = `@agent what does greet return? (${Date.now()})`;
  await page.getByLabel('Message', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  const messages = page.getByRole('list', { name: 'Messages' });
  await expect(messages.getByText(question)).toBeVisible();

  // The worker answers; the room updates live.
  const answer = messages.locator('li').last();
  await expect(answer.getByText('returns "hi"')).toBeVisible({ timeout: 30_000 });
  await expect(answer.getByText('Repo Agent')).toBeVisible();
  const source = answer.getByRole('link', { name: 'src/app.ts:1' });
  await expect(source).toHaveAttribute('href', /\/acme-demo\/web\/blob\/[0-9a-f]{40}\/src\/app\.ts#L1$/);

  // One click to a pre-filled task form; nothing is created until it's saved.
  await answer.getByRole('button', { name: 'Make this a task' }).click();
  await expect(page).toHaveURL(/\/repos\/web\/new/, { timeout: 30_000 });
  await expect(page.getByLabel('Title')).toHaveValue('`greet()` returns "hi" (`src/app.ts:1`).');
  await expect(page.getByLabel('Description')).toHaveValue(/## References\n- \[src\/app\.ts:1\]\(.+#L1\)/);

  // The Repo Agent's memory.
  await page.goto('/o/acme-demo/repos/web/agent');
  await expect(page.getByRole('heading', { name: 'Repo Agent memory' })).toBeVisible({ timeout: 30_000 });
  const note = `Never call the payments API from the web app. (${Date.now()})`;
  await page.getByRole('button', { name: 'Edit Rules' }).click();
  await page.getByLabel('Rules').fill(note);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(note)).toBeVisible();
  await expect(page.getByText(/Updated .* by demo-owner/).first()).toBeVisible();
});
