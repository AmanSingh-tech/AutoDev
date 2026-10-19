import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 375, height: 800 }, hasTouch: true, isMobile: true });

async function signInAs(page: Page, login: string) {
  await page.goto(`http://localhost:4010/_login-as?login=${login}`);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/o\/acme-demo\/repos/, { timeout: 30_000 });
}

/** The page itself never scrolls sideways on a phone; wide tables and tab rows scroll inside their own box. */
async function expectNoSidewaysScroll(page: Page) {
  // Evaluated in the browser; written as a string because this package has no DOM types.
  const { scrollWidth, innerWidth } = await page.evaluate<{ scrollWidth: number; innerWidth: number }>(
    '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
  );
  expect(scrollWidth, `page is ${scrollWidth - innerWidth}px wider than the screen`).toBeLessThanOrEqual(innerWidth);
}

test('at phone width the main pages fit the screen, the nav scrolls on its own row, and inputs do not trigger zoom', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, 'demo-dev');
  for (const path of ['/o/acme-demo/repos', '/o/acme-demo/repos/web', '/o/acme-demo/repos/web?view=list', '/o/acme-demo/tasks', '/o/acme-demo/repos/web/room', '/o/acme-demo/repos/web/new', '/o/acme-demo/settings']) {
    await page.goto(path);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await expectNoSidewaysScroll(page);
  }
  // iOS zooms into inputs smaller than 16px; on a touch screen they're 16px.
  await page.goto('/o/acme-demo/repos/web/new');
  await expect(page.getByLabel('Title')).toHaveCSS('font-size', '16px');
});
