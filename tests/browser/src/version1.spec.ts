/**
 * Version 1 features in a real browser: importing a bank statement, opening
 * Finken with no connection, and the daily reminder.
 */
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { availableMoney, BUILT_URL, enterAsGuest } from './helpers';

const STATEMENT = join(import.meta.dirname, '../fixtures/statement.csv');

test('imports a bank statement once, with the right total, and adds nothing the second time', async ({ page }) => {
  await enterAsGuest(page);
  const before = await availableMoney(page);
  await page.goto('/more/import');
  await page.locator('input[type=file]').setInputFiles(STATEMENT);

  // Read the way a Pakistani bank writes it: day-first dates, money out and in in their own columns.
  await expect(page.getByText('7 to add: Rs. 20,600.50 out and Rs. 85,000 in.')).toBeVisible();
  await expect(page.getByLabel('Dates are written')).toHaveValue('DMY');
  await expect(page.getByLabel('Money out column')).toHaveValue('2');
  await expect(page.getByLabel('Category for line 5')).toHaveText(/Food/);
  await expect(page.getByLabel('Category for line 5').locator('option:checked')).toHaveText('Food');
  await expect(page.getByLabel('Category for line 6').locator('option:checked')).toHaveText('Bills');
  // Change one by hand.
  await page.getByLabel('Category for line 10').selectOption({ label: 'Other' });
  await page.getByRole('button', { name: 'Import 7 transactions' }).click();
  await expect(page.getByText('7 transactions were added to Bank Account.')).toBeVisible();
  expect(await availableMoney(page)).toBe(before - 2060050 + 8500000);

  await page.goto('/more/import');
  await page.locator('input[type=file]').setInputFiles(STATEMENT);
  await expect(page.getByText(/^0 to add: .* 7 already in Bank Account, so left out\.$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nothing new to import' })).toBeDisabled();
  expect(await availableMoney(page)).toBe(before - 2060050 + 8500000);
});

test('can be installed, and opens with no connection', async ({ page, context }) => {
  // What a browser checks before offering to install.
  const manifest = await (await page.request.get(`${BUILT_URL}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ name: 'Finken', start_url: '/', display: 'standalone' });
  for (const icon of manifest.icons as { src: string }[]) expect((await page.request.get(`${BUILT_URL}${icon.src}`)).ok(), icon.src).toBe(true);

  await enterAsGuest(page, BUILT_URL);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first visit is not controlled yet; after a reload the service worker serves everything.
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const total = await availableMoney(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Money', level: 1 })).toBeVisible();
  // Screens never opened before work too: the whole app was kept.
  await page.goto(`${BUILT_URL}/insights`);
  await expect(page.locator('main')).toContainText(/Insights/);
  expect(await availableMoney(page)).toBe(total);
  await context.setOffline(false);
});

test('shows one reminder a day when something is due, without amounts or names', async ({ page, context }) => {
  await context.grantPermissions(['notifications'], { origin: BUILT_URL });
  await enterAsGuest(page, BUILT_URL);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Something due today, so there is a reminder whatever the demo data holds.
  await page.goto(`${BUILT_URL}/money/recurring`);
  await page.getByRole('button', { name: 'New recurring item' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Fibre internet');
  await dialog.getByLabel(/^Amount/).fill('2500');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  await dialog.getByLabel('First due').fill(today);
  await dialog.getByRole('button', { name: /^(Save|Add)/ }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`${BUILT_URL}/more/settings`);
  await page.getByRole('button', { name: 'Turn on reminders' }).click();
  await expect(page.getByText(/^On\. Once a day/)).toBeVisible();
  const shown = async () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })));
  await expect.poll(async () => (await shown()).length).toBe(1);
  const [reminder] = await shown();
  expect(reminder.tag).toMatch(/^finken-reminder-\d{4}-\d{2}-\d{2}$/);
  expect(reminder.body).toMatch(/^(\d+ (payment is|payments are|amount is|amounts are) [a-z ]+(, | and )?)+\. Open Finken to see them\.$/);
  expect(`${reminder.title} ${reminder.body}`).not.toMatch(/Rs|internet|\d{3,}/i);

  // Opening Finken again the same day shows nothing new.
  await page.reload();
  await page.waitForTimeout(1000);
  expect(await shown()).toHaveLength(1);

  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText(/^Get one notification a day/)).toBeVisible();
});
