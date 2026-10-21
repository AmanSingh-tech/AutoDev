import { expect, test, type Page } from '@playwright/test';

test.setTimeout(120_000);

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

/** Other specs don't expect links, so every link goes even when the test fails. */
async function removeLinks(page: Page) {
  await page.goto('/o/acme-demo/settings/links');
  await expect(page.getByRole('heading', { name: 'Linked repositories' })).toBeVisible();
  await expect(page.getByText(/No linked repositories yet|Remove link/).first()).toBeVisible();
  while (await page.getByRole('button', { name: 'Remove link' }).count()) {
    await page.getByRole('button', { name: 'Remove link' }).first().click();
    await page.waitForTimeout(500);
  }
}

test.afterEach(async ({ page }) => {
  await removeLinks(page);
});

test('an admin links api → web; a finished api task is applied to web as a draft that carries the change', async ({ page }) => {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'demo-owner');
  await removeLinks(page);

  // Link the repos, with notes for the agent.
  await page.getByLabel('From', { exact: true }).selectOption({ label: 'acme-demo/api' });
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'acme-demo/web' });
  await page.getByLabel('How the repositories map').first().fill('api/src/audit ↔ web/src/audit');
  await page.getByRole('button', { name: 'Link repositories' }).click();
  const links = page.getByRole('list', { name: 'Links' });
  await expect(links.getByText('acme-demo/api')).toBeVisible();
  await expect(links.getByText('acme-demo/web')).toBeVisible();

  // The seeded open-PR task in api has a change; apply it to web.
  await page.goto('/o/acme-demo/tasks?q=Paginate');
  // The seeded original, not a port of it left by an earlier run ("Port AD-5: Paginate…").
  await page.getByRole('link', { name: /^[A-Z][A-Z0-9]*-\d+\s*Paginate the audit log endpoint$/ }).click();
  await expect(page.getByRole('heading', { name: 'Paginate the audit log endpoint' })).toBeVisible({ timeout: 30_000 });
  const sourceKey = (await page.locator('span.font-mono').first().textContent())!.trim();
  await page.getByRole('button', { name: 'Apply to acme-demo/web' }).click();

  // The port: a draft in web, linked back, with the change and the notes attached.
  await expect(page.getByRole('heading', { name: `Port ${sourceKey}: Paginate the audit log endpoint` })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('acme-demo/web').first()).toBeVisible();
  await expect(page.getByText('Draft').first()).toBeVisible();
  await expect(page.getByText('Ported from')).toBeVisible();
  await page.getByText(/What the agent gets from/).click();
  await expect(page.getByText('api/src/audit ↔ web/src/audit')).toBeVisible();
  await expect(page.getByText(/export function paginate/)).toBeVisible();
  const portKey = (await page.locator('span.font-mono').first().textContent())!.trim();

  // And the source lists it.
  await page.getByRole('link', { name: new RegExp(`${sourceKey} Paginate`) }).click();
  await expect(page.getByText('Ported to')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: new RegExp(`${portKey} acme-demo/web`) })).toBeVisible();

  // Cancel the port so reruns against the same dev DB start from the seeded state.
  await page.goto(`/o/acme-demo/tasks/${portKey}`);
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
});
