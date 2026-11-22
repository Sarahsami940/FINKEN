/**
 * Phase 8, the closed beta, in a real browser: the invite code comes before
 * anything else, usage is counted only after saying yes, and feedback can be
 * sent from any screen. The test API runs invite-only with INVITE_CODE.
 */
import { expect, type Page, test } from '@playwright/test';
import { ACCOUNT_URL, expectAccessible, INVITE_CODE, signUp } from './helpers';

async function signInOnly(page: Page, email: string) {
  await page.goto(ACCOUNT_URL);
  await signUp(page, email, 'Noor');
}

test('the invite code comes first; a wrong one is explained; the right one lets you in', async ({ page }) => {
  await signInOnly(page, 'noor@example.com');
  await expect(page.getByRole('heading', { name: 'Enter your invite code' })).toBeVisible();
  await expect(page.getByText('You are signed in as noor@example.com')).toBeVisible();
  await expectAccessible(page, 'Invite code');

  await page.getByLabel('Invite code').fill('FNK-NOPE-NOPE');
  await page.getByRole('button', { name: 'Join the beta' }).click();
  await expect(page.getByRole('alert')).toHaveText('That invite code is not right, or it has been used up. Check it and try again.');

  // Typed loosely: lower case, spaces instead of dashes.
  await page.getByLabel('Invite code').fill(INVITE_CODE.toLowerCase().replace(/-/g, ' '));
  await page.getByRole('button', { name: 'Join the beta' }).click();
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();

  // Still in after a reload: the server remembers.
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();
});

test('usage is counted only after saying yes, and never holds amounts or names', async ({ page }) => {
  const sent: { name: string; n: number }[][] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/v1/usage')) sent.push((req.postDataJSON() as { events: { name: string; n: number }[] }).events);
  });

  await signInOnly(page, 'omar@example.com');
  await page.getByLabel('Invite code').fill(INVITE_CODE);
  await page.getByRole('button', { name: 'Join the beta' }).click();
  // A first Space, so Home opens.
  await page.getByRole('button', { name: 'Start using Finken' }).click();

  const question = page.getByRole('heading', { name: 'Help improve Finken during the beta?' });
  await expect(question).toBeVisible();
  await expectAccessible(page, 'Usage question');
  // Before answering, moving around sends nothing.
  await page.goto(`${ACCOUNT_URL}/transactions`);
  await page.goto(ACCOUNT_URL);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await page.getByRole('button', { name: 'Share usage' }).click();
  await expect(question).toHaveCount(0);
  await page.getByRole('link', { name: 'Transactions' }).first().click();
  await expect(page).toHaveURL(/\/transactions$/);
  await page.getByRole('link', { name: 'Insights' }).first().click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Insights' })).toBeVisible();
  // Going to the background sends what was counted.
  const flushed = page.waitForRequest((req) => req.url().endsWith('/api/v1/usage'));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flushed;
  const names = sent.flat().map((e) => e.name);
  expect(names).toEqual(expect.arrayContaining(['screen:transactions', 'screen:insights']));
  for (const name of names) expect(name).toMatch(/^[a-z]+:[a-z-]+$/);

  // Settings says so, and can turn it off.
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }));
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await expect(page.getByText('On: usage is counted.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(page.getByText('Off: nothing is counted.')).toBeVisible();
});

test('feedback can be sent from any screen, with the screen it is about', async ({ page }) => {
  await signInOnly(page, 'zara@example.com');
  await page.getByLabel('Invite code').fill(INVITE_CODE);
  await page.getByRole('button', { name: 'Join the beta' }).click();
  await page.getByRole('button', { name: 'Start using Finken' }).click();
  await page.getByRole('button', { name: 'No thanks' }).click();

  await page.goto(`${ACCOUNT_URL}/money/budgets`);
  await page.getByRole('button', { name: 'Send feedback' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Sent with it: the screen \(Budgets\)/)).toBeVisible();
  await expectAccessible(page, 'Feedback dialog');
  await expect(dialog.getByRole('button', { name: 'Send feedback' })).toBeDisabled();

  await dialog.getByRole('radio', { name: 'An idea' }).click();
  await dialog.getByLabel('Your message').fill('A budget that rolls over unspent money would help.');
  const [request] = await Promise.all([page.waitForRequest((req) => req.url().endsWith('/api/v1/feedback')), dialog.getByRole('button', { name: 'Send feedback' }).click()]);
  expect(request.postDataJSON()).toMatchObject({ kind: 'idea', message: 'A budget that rolls over unspent money would help.', screen: 'budgets' });
  await expect(page.getByText('Thank you. Your feedback was sent to the Finken team.')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
