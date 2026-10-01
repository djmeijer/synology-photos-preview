import { test, expect, type Page } from '@playwright/test';

async function connect(page: Page, username: string) {
  await page.goto('/');
  await expect(page.getByText('Desktop connected', { exact: true })).toBeVisible();
  const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
  if (await disconnect.isVisible()) await disconnect.click();
  await page.getByLabel('NAS address').fill('https://nas.example.com:5001');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill('secret');
  await page.getByLabel(/Two-factor code/).fill('123456');
  await page.getByRole('button', { name: 'Connect to NAS' }).click();
  await expect(page.getByText('Connected as')).toBeVisible();
}

async function stop(page: Page) {
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
}
test('OTP login, direct execution, pause/resume, browser refresh reconnects to the same job, stop', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Desktop connected', { exact: true })).toBeVisible();
  await page.getByLabel('NAS address').fill('https://nas.example.com:5001');
  await page.getByLabel('Username', { exact: true }).fill('desktop-user');
  await page.getByLabel('Password', { exact: true }).fill('secret');
  await page.getByRole('button', { name: 'Connect to NAS' }).click();
  await expect(page.getByRole('alert')).toContainText('Two-factor');
  await page.getByLabel('Password', { exact: true }).fill('secret');
  await page.getByLabel('Two-factor code required').fill('123456');
  await page.getByRole('button', { name: 'Connect to NAS' }).click();
  await expect(page.getByText('Connected as')).toBeVisible();
  await page.getByLabel('Space', { exact: true }).selectOption('both');
  await expect(page.getByRole('heading', { name: 'Library backlog' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Choose space' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Generate previews' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Execute now' })).toBeEnabled();
  await page.getByRole('button', { name: 'Execute now' }).click();
  await expect(page.getByText(/Dates of last 100 loaded files:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  const original = await page.request.get('/api/state').then(r => r.json());
  expect(original.job.mediaDateFrom).toBe('2020-01-21T00:00:00.000Z');
  expect(original.job.mediaDateTo).toBe('2020-04-29T00:00:00.000Z');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const reconnected = await page.request.get('/api/state').then(r => r.json());
  expect(reconnected.job.id).toBe(original.job.id);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('secret');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('stopped · Both spaces', { exact: true })).toBeVisible();
  const stopped = await page.request.get('/api/state').then(r => r.json());
  expect(stopped.job.failed).toBe(0); expect(stopped.job.cancelled).toBeGreaterThan(0);
  await page.screenshot({ path: '.test-data/interface.png', fullPage: true });
});

test('unavailable spaces are disabled and the active selection survives refresh', async ({ page }) => {
  await connect(page, 'personal-only');
  const space = page.getByLabel('Space', { exact: true });
  await expect(space).toHaveValue('personal');
  await expect(space.locator('option[value="shared"]')).toHaveAttribute('disabled', '');
  await expect(space.locator('option[value="both"]')).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: 'Execute now' }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.reload();
  await expect(space).toHaveValue('personal');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(page.getByText(/files settled in this run/)).toBeVisible();
  await stop(page);
});

test('missing dates, single-day ranges, and compatibility warnings are displayed', async ({ page }) => {
  for (const username of ['unknown-dates', 'one-day', 'warnings']) {
    await connect(page, username);
    await page.getByRole('button', { name: 'Execute now' }).click();
    const dates = page.locator('p').filter({ hasText: /Dates of last 100 loaded files:/ });
    await expect(dates).toBeVisible();
    if (username === 'unknown-dates') await expect(dates).toContainText('Dates unavailable');
    if (username === 'one-day') {
      const formatted = await page.evaluate(() => new Date('2021-01-01T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
      await expect(dates).toHaveText(`Dates of last 100 loaded files: ${formatted}`);
    }
    if (username === 'warnings') {
      await expect(page.getByText(/1 unsupported Live Photo video component/)).toBeVisible();
      await expect(page.getByText('Run warnings (1)', { exact: true })).toBeVisible();
      await expect(page.getByText(/Skipped live.mov/)).toBeVisible();
    }
    await stop(page);
  }
});
