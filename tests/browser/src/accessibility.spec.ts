/**
 * Every main screen, scanned with axe against WCAG 2.1 A and AA. Anything
 * serious or critical fails the test, naming the rule and where it is.
 */
import { expect, test } from '@playwright/test';
import { ACCOUNT_URL, describeFindings, enterAsGuest, expectAccessible, type Finding, LOCAL_URL, scan } from './helpers';

test('before signing in', async ({ page }) => {
  await page.goto(LOCAL_URL);
  await expectAccessible(page, 'Welcome');
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expectAccessible(page, 'Create your account');
  await page.goto(LOCAL_URL);
  await page.getByRole('button', { name: 'Try Finken' }).click();
  await expectAccessible(page, 'Choose a demo Space');
  await page.goto(ACCOUNT_URL);
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expectAccessible(page, 'Account sign-in');
});

const SCREENS: [string, string][] = [
  ['Home', '/'],
  ['Today', '/today'],
  ['Transactions', '/transactions'],
  ['Money', '/money'],
  ['Coming up', '/money/upcoming'],
  ['Budgets', '/money/budgets'],
  ['Goals', '/money/goals'],
  ['Recurring', '/money/recurring'],
  ['People', '/money/people'],
  ['Loans', '/money/loans'],
  ['To receive', '/money/receivables'],
  ['To pay', '/money/payables'],
  ['Insights', '/insights'],
  ['Search', '/search'],
  ['More', '/more'],
  ['Spaces', '/more/spaces'],
  ['Categories', '/more/categories'],
  ['Settings', '/more/settings'],
  ['Import', '/more/import'],
];

test('every screen inside Finken', async ({ page }) => {
  // Nineteen screens, each fully loaded and scanned.
  test.setTimeout(240_000);
  await enterAsGuest(page);
  const findings: Finding[] = [];
  for (const [name, path] of SCREENS) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
    findings.push(...(await scan(page, name)));
  }
  expect(findings.length, describeFindings(findings)).toBe(0);
});

test('dialogs and the business screen', async ({ page }) => {
  await enterAsGuest(page);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expectAccessible(page, 'Add menu');
  await page.getByRole('button', { name: /^Expense/ }).click();
  await expectAccessible(page, 'Expense form');
  await page.keyboard.press('Escape');
  await page.goto('/transactions');
  await page.locator('main').getByRole('button').filter({ hasText: /Rs\./ }).first().click();
  await expectAccessible(page, 'Transaction details');
  await page.keyboard.press('Escape');
  // The Business Space has its own screen.
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
  await page.goto('/business');
  await expect(page.locator('main')).toBeVisible();
  await expectAccessible(page, 'Business');
});
