/**
 * The real sign-in path in a real browser: Finken sends people to the
 * sign-in provider's page, they come back signed in, stay signed in as their
 * token is renewed, and logging out ends the provider's session too. The
 * provider here is the stand-in (apps/api/scripts/dev-sign-in.ts), which
 * speaks the same standard as Auth0, Google or Keycloak.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, SIGN_IN_PROVIDER, SIGN_IN_URL } from './helpers';

const session = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('finken:session') ?? 'null') as { idToken: string; refreshToken: string } | null);

test('signs up on the provider’s page, stays signed in, and signs out everywhere', async ({ page }) => {
  await page.goto(SIGN_IN_URL);
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expect(page.getByRole('heading', { name: 'Create your Finken account' })).toBeVisible();
  await expect(page.getByText('Finken never sees your password.')).toBeVisible();
  await expectAccessible(page, 'Sign in with a provider');
  await page.getByRole('button', { name: 'Continue to create your account' }).click();

  // On the provider's own page now.
  await expect(page).toHaveURL(new RegExp(`^${SIGN_IN_PROVIDER}/authorize\\?`));
  await page.getByLabel('Email').fill('noor@example.com');
  await page.getByLabel('Name').fill('Noor');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Back in Finken, signed in, with the address cleaned up.
  await expect(page.getByRole('heading', { name: 'Welcome, Noor' })).toBeVisible();
  await expect(page).toHaveURL(`${SIGN_IN_URL}/`);
  await page.getByRole('button', { name: 'Start using Finken' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Noor/ })).toBeVisible();

  // Tokens here last 65 seconds and are renewed in their last minute, so the next request renews.
  const first = await session(page);
  expect(first?.refreshToken).toBeTruthy();
  // Into the token's last minute; the next request (opening Finken again) renews it.
  await page.waitForTimeout(6_000);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Noor/ })).toBeVisible();
  await expect.poll(async () => (await session(page))?.idToken, { timeout: 15_000 }).not.toBe(first?.idToken);

  // Log out: the provider's session ends too, and Finken opens at the start.
  await page.goto(`${SIGN_IN_URL}/more/settings`);
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible();
  expect(await session(page)).toBeNull();

  // Signing in again is the same account, with the Space made before.
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await page.getByLabel('Email').fill('noor@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Noor/ })).toBeVisible();
});

test('cancelling on the provider’s page says so, and trying again works', async ({ page }) => {
  await page.goto(SIGN_IN_URL);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Signing in did not finish' })).toBeVisible();
  await expect(page.getByText('Signing in was cancelled.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(new RegExp(`^${SIGN_IN_PROVIDER}/authorize\\?`));
});
