/**
 * The main money flow, by hand, in a real browser: add an expense, see every
 * figure move by exactly that much, change it, delete it, undo, and find it
 * all still there after a reload.
 */
import { expect, test } from '@playwright/test';
import { availableMoney, enterAsGuest } from './helpers';

test('an expense moves the balance by exactly its amount, through edit, delete, undo and reload', async ({ page }) => {
  await enterAsGuest(page);
  const before = await availableMoney(page);

  // Add Rs. 1,250.50 for lunch.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /^Expense/ }).click();
  await page.getByLabel('Amount', { exact: true }).fill('1250.50');
  await page.getByLabel('Description').fill('Browser test lunch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await availableMoney(page)).toBe(before - 125050);

  // Change it to Rs. 2,000.
  await page.goto('/transactions');
  await page.getByText('Browser test lunch').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Amount', { exact: true }).fill('2000');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await availableMoney(page)).toBe(before - 200000);

  // Delete it and undo: it is back, with the same balance.
  const remove = async () => {
    await page.goto('/transactions');
    await page.getByText('Browser test lunch').first().click();
    await page.getByRole('button', { name: 'Delete transaction' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Transaction deleted')).toBeVisible();
  };
  await remove();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Browser test lunch').first()).toBeVisible();
  expect(await availableMoney(page)).toBe(before - 200000);

  // Delete it for good: the balance is back where it started, and stays there after a reload.
  await remove();
  expect(await availableMoney(page)).toBe(before);
  await page.reload();
  expect(await availableMoney(page)).toBe(before);
  await page.goto('/transactions');
  await expect(page.getByText('Browser test lunch')).toHaveCount(0);
});

test('a double-clicked save records the expense once', async ({ page }) => {
  await enterAsGuest(page);
  const before = await availableMoney(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: /^Expense/ }).click();
  await page.getByLabel('Amount', { exact: true }).fill('999');
  await page.getByLabel('Description').fill('Double click');
  await page.getByRole('button', { name: 'Save', exact: true }).dblclick();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await availableMoney(page)).toBe(before - 99900);
  await page.goto('/transactions');
  await expect(page.getByText('Double click')).toHaveCount(1);
});
