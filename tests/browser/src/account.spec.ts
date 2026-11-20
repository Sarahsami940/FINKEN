/**
 * With an account, in a real browser: data saved in this browser before
 * signing in is moved into the account with the same figures; the person can
 * take a copy of everything and delete the account for good.
 */
import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { ACCOUNT_URL, availableMoney, INVITE_CODE, paisa } from './helpers';

/** What a guest saved in this browser before accounts: one Space, an account and an expense. */
async function plantBrowserData(page: Page) {
  await page.goto(ACCOUNT_URL);
  await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('finken');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const at = '2026-11-01T09:00:00.000Z';
    const records: Record<string, object[]> = {
      users: [{ id: 'guest', name: '', isGuest: true, timeZone: 'Asia/Karachi' }],
      spaces: [{ id: 'old-shop', ownerId: 'guest', name: 'Shop notes', type: 'business', icon: 'briefcase', description: '', currency: 'PKR', createdAt: at, status: 'active' }],
      accounts: [{ id: 'old-till', spaceId: 'old-shop', name: 'Till', kind: 'cash', openingBalance: 500000, createdAt: at }],
      categories: [{ id: 'old-stock', spaceId: 'old-shop', name: 'Stock', kind: 'expense', icon: 'package', color: 'orange', subcategories: [], createdAt: at }],
      transactions: [
        {
          id: 'old-expense',
          spaceId: 'old-shop',
          type: 'expense',
          amount: 125050,
          currency: 'PKR',
          date: '2026-11-01',
          description: 'Paper stock',
          accountId: 'old-till',
          categoryId: 'old-stock',
          status: 'confirmed',
          createdAt: at,
          updatedAt: at,
        },
      ],
    };
    const tx = db.transaction(Object.keys(records), 'readwrite');
    for (const [store, items] of Object.entries(records)) for (const item of items) tx.objectStore(store).put(item);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
}

async function signIn(page: Page, email: string) {
  await page.getByRole('button', { name: 'Get Started' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Your name').fill('Dana');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The beta is invite-only: a new account enters the code once.
  await page.getByLabel('Invite code').fill(INVITE_CODE);
  await page.getByRole('button', { name: 'Join the beta' }).click();
}

test('moves browser data into the account, then exports and deletes the account', async ({ page }) => {
  await plantBrowserData(page);
  await signIn(page, 'dana@example.com');

  // Offered straight after signing in, with the Space already chosen (it is not sample data).
  await expect(page.getByRole('heading', { name: 'Bring your data into your account' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Shop notes/ })).toBeChecked();
  await page.getByRole('button', { name: 'Move 1 Space into dana@example.com' }).click();
  const result = page.getByText(/^Moved 1 transaction and checked/);
  await expect(result).toBeVisible();
  // Rs. 5,000 opening, less Rs. 1,250.50 spent.
  expect(paisa(await result.innerText())).toBe(374950);
  await page.getByRole('button', { name: 'Continue to Finken' }).click();
  expect(await availableMoney(page)).toBe(374950);

  // A copy of everything.
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await expect(page.getByText(/^Up to date/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all your data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^finken-export-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(await readFile((await download.path())!, 'utf8')) as { profile: { email: string }; records: { transactions: { id: string; amount: number }[] } };
  expect(data.profile.email).toBe('dana@example.com');
  expect(data.records.transactions).toEqual([expect.objectContaining({ id: 'old-expense', amount: 125050 })]);

  // Deleting needs the word, then everything is gone.
  await page.getByRole('button', { name: 'Delete account' }).click();
  const confirm = page.getByRole('button', { name: 'Delete my account for good' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible();

  // Signing in again starts an empty account. The browser's own copy was already moved once, so it is not offered again.
  await signIn(page, 'dana@example.com');
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
  await expect(page.getByText('Bring your data into your account')).toHaveCount(0);
});
