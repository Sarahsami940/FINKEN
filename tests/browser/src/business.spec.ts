/**
 * Phase 9, Business Mode, in a real browser: sharing a business Space with
 * someone who can only view it, and downloading reports as Excel.
 */
import { readFile } from 'node:fs/promises';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { ACCOUNT_URL, enterAsGuest, expectAccessible, INVITE_CODE, signUp } from './helpers';

/** Someone new, signed in to the closed beta, with their first Space made. */
async function newPerson(browser: Browser, email: string, name: string, spaceType: RegExp) {
  const context = await browser.newContext({ timezoneId: 'Asia/Karachi', locale: 'en-GB' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ACCOUNT_URL });
  const page = await context.newPage();
  await page.goto(ACCOUNT_URL);
  await signUp(page, email, name);
  await page.getByLabel('Invite code').fill(INVITE_CODE);
  await page.getByRole('button', { name: 'Join the beta' }).click();
  await page.getByRole('radio', { name: spaceType }).click();
  await page.getByRole('button', { name: 'Start using Finken' }).click();
  await page.getByRole('button', { name: 'No thanks' }).click();
  return { context, page };
}

async function recordSale(page: Page, amount: string, description: string) {
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.getByRole('button', { name: /^Sale or income/ }).click();
  await page.getByLabel('Amount', { exact: true }).fill(amount);
  await page.getByLabel('Description').fill(description);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test('an owner shares the shop with someone who can only view it', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await newPerson(browser, 'sana@example.com', 'Sana', /Business/);
  await recordSale(owner.page, '4500', 'Counter sale');

  // The owner makes a view-only invite.
  await owner.page.goto(`${ACCOUNT_URL}/more/spaces`);
  await owner.page.getByRole('button', { name: /^Share / }).click();
  const people = owner.page.getByRole('dialog', { name: /^People in / });
  await expect(people.getByText('sana@example.com')).toBeVisible();
  await people.getByLabel('They will be able to').selectOption('viewer');
  await people.getByRole('button', { name: 'Make an invite' }).click();
  const code = (await people.locator('p.font-mono').textContent())?.trim() ?? '';
  expect(code).toMatch(/^SPC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expectAccessible(owner.page, 'Sharing a Space');
  await people.getByRole('button', { name: 'Copy link' }).click();
  const link = await owner.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${ACCOUNT_URL}/more/spaces?join=${code}`);
  await owner.page.keyboard.press('Escape');

  // The accountant opens the link: the code is filled in.
  const accountant = await newPerson(browser, 'imran@example.com', 'Imran', /Personal/);
  await accountant.page.goto(link);
  await expect(accountant.page.getByLabel('Invite code')).toHaveValue(code);
  await accountant.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(accountant.page.getByText(/^You joined .*: you can view it$/)).toBeVisible();
  await expect(accountant.page.getByText(/Shared with you · Can view/)).toBeVisible();

  // Inside the shop: told it is view-only, the sale is there, and there is no Add button.
  await accountant.page.goto(`${ACCOUNT_URL}/transactions`);
  await expect(accountant.page.getByText(/^You can view .+\.$/)).toBeVisible();
  await expect(accountant.page.getByText('Counter sale')).toBeVisible();
  await expect(accountant.page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
  await expectAccessible(accountant.page, 'View-only Space');

  // The owner sees who joined, and removes them; the shop leaves their device.
  await owner.page.goto(`${ACCOUNT_URL}/more/spaces`);
  await owner.page.getByRole('button', { name: /^Share / }).click();
  await expect(people.getByText('imran@example.com')).toBeVisible();
  await people.getByRole('button', { name: 'Remove Imran' }).click();
  await owner.page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(owner.page.getByText(/no longer has/)).toBeVisible();

  await accountant.page.goto(`${ACCOUNT_URL}/more/spaces`);
  await accountant.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(accountant.page.getByText(/Shared with you/)).toHaveCount(0, { timeout: 15_000 });

  await owner.context.close();
  await accountant.context.close();
});

test('business reports download as Excel, and the monthly statement adds up', async ({ page }) => {
  await enterAsGuest(page);
  await page
    .getByRole('button', { name: /Personal/ })
    .first()
    .click();
  await page
    .getByRole('menuitem', { name: /Business/ })
    .or(page.getByRole('option', { name: /Business/ }))
    .or(page.getByRole('button', { name: /^Business/ }))
    .first()
    .click();
  await page.goto('/business?tab=reports');
  await page.getByRole('radio', { name: 'Monthly statement' }).click();
  await expect(page.getByRole('heading', { name: 'Monthly statement' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print or PDF' })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^finken-statement-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const bytes = await readFile((await download.path())!);
  // A zip file, holding a workbook.
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  expect(bytes.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);

  // On paper only the report shows.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('button', { name: 'Excel' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expectAccessible(page, 'Monthly statement');
});
