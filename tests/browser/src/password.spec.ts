/**
 * Finken's own sign-in in a real browser: creating an account, confirming
 * the email, staying signed in with nothing secret readable by the page,
 * wrong passwords, a forgotten password, and changing it.
 * The test API is a development server: emails are not sent, they are
 * listed at /v1/dev/mail, and the screens link to them.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { ACCOUNT_URL, expectAccessible, INVITE_CODE, signUp, TEST_PASSWORD } from './helpers';

const API = 'http://127.0.0.1:4100';

/** The link in the newest email Finken would have sent to this address, as a path in the app. */
async function emailLink(request: APIRequestContext, to: string, subject: RegExp) {
  const { emails } = (await (await request.get(`${API}/v1/dev/mail?to=${encodeURIComponent(to)}`)).json()) as { emails: { subject: string; link: string }[] };
  const email = emails.find((e) => subject.test(e.subject));
  expect(email, `an email to ${to} matching ${subject}`).toBeTruthy();
  return email!.link.replace(/^https?:\/\/[^/]+/, '');
}

async function joinAndStart(page: Page) {
  await page.getByLabel('Invite code').fill(INVITE_CODE);
  await page.getByRole('button', { name: 'Join the beta' }).click();
  await page.getByRole('button', { name: 'Start using Finken' }).click();
  await page.getByRole('button', { name: 'No thanks' }).click();
}

async function logIn(page: Page, email: string, password: string) {
  await page.getByRole('button', { name: 'Log in' }).first().click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
}

async function logOut(page: Page) {
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Get Started' })).toBeVisible();
}

const greeting = (page: Page, name: string) => expect(page.getByRole('heading', { name: new RegExp(`Good (morning|afternoon|evening), ${name}`) })).toBeVisible();

test('an account is created, confirmed and kept signed in, with nothing secret readable by the page', async ({ page, request }) => {
  await page.goto(ACCOUNT_URL);
  await page.getByRole('button', { name: 'Get Started' }).click();
  await expectAccessible(page, 'Create an account');

  // A password that is too easy is refused, with the reason, next to the field.
  await page.getByLabel('Your name').fill('Hina');
  await page.getByLabel('Email').fill('hina@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Type the password again').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('That password is too easy to guess. Try a few unrelated words together.')).toBeVisible();
  // The eye button shows what was typed.
  await page.getByRole('button', { name: 'Show password' }).first().click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');

  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Type the password again').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await joinAndStart(page);
  await greeting(page, 'Hina');

  // The session cookie cannot be read by page scripts, and no token is kept in the page's storage.
  expect(await page.evaluate(() => document.cookie)).not.toContain('finken_session');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/);
  expect(stored).not.toContain(TEST_PASSWORD);
  const cookie = (await page.context().cookies()).find((c) => c.name === 'finken_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });

  // Opening Finken again keeps them signed in: a new access token comes from the cookie.
  await page.reload();
  await greeting(page, 'Hina');

  // Settings says the email is not confirmed; the emailed link confirms it.
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await expect(page.getByText('Not confirmed yet')).toBeVisible();
  await expectAccessible(page, 'Sign-in and security');
  await page.goto(`${ACCOUNT_URL}${await emailLink(request, 'hina@example.com', /^Confirm your email/)}`);
  await expect(page.getByRole('heading', { name: 'Your email is confirmed' })).toBeVisible();
  // The token is taken out of the address straight away.
  expect(page.url()).not.toContain('token');
  await page.getByRole('button', { name: 'Open Finken' }).click();
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
});

test('wrong passwords, a forgotten password, and changing it', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto(ACCOUNT_URL);
  await signUp(page, 'omar.k@example.com', 'Omar');
  await joinAndStart(page);
  await logOut(page);

  // A wrong password, and an email with no account, get the same answer.
  await logIn(page, 'omar.k@example.com', 'not my password at all');
  const wrong = page.getByRole('alert');
  await expect(wrong).toHaveText('That email and password do not match a Finken account.');
  await expectAccessible(page, 'Log in');
  await page.getByLabel('Email').fill('nobody.here@example.com');
  await page.getByLabel('Password', { exact: true }).fill('not my password at all');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(wrong).toHaveText('That email and password do not match a Finken account.');

  // Forgot: the same message whether or not the account exists; the email's link sets a new password.
  await page.getByLabel('Email').fill('omar.k@example.com');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await expect(page.getByLabel('Email')).toHaveValue('omar.k@example.com');
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText(/If omar\.k@example\.com has a Finken account, an email with a link to set a new password is on its way\./)).toBeVisible();
  await page.getByRole('link', { name: 'Open the email’s link' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  expect(page.url()).not.toContain('token');
  await page.getByLabel('New password').fill('a new phrase for tuesday');
  await page.getByLabel('Type it again').fill('a new phrase for tuesday');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await greeting(page, 'Omar');
  // The link worked once.
  await page.goto(`${ACCOUNT_URL}${await emailLink(request, 'omar.k@example.com', /^Set a new Finken password/)}`);
  await page.getByLabel('New password').fill('yet another phrase here');
  await page.getByLabel('Type it again').fill('yet another phrase here');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('alert')).toHaveText('That link has expired or was already used. Ask for a new one.');
  // An old link changes nothing: still signed in.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await greeting(page, 'Omar');

  // Changing the password needs the current one.
  await page.goto(`${ACCOUNT_URL}/more/settings`);
  await page.getByRole('button', { name: 'Change password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change your password' });
  await dialog.getByLabel('Current password').fill('a wrong current one');
  await dialog.getByLabel('New password', { exact: true }).fill('the third phrase now');
  await dialog.getByLabel('Type the new password again').fill('the third phrase now');
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog.getByText('Your current password is not right.')).toBeVisible();
  await dialog.getByLabel('Current password').fill('a new phrase for tuesday');
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed. Every other device has been signed out.')).toBeVisible();

  // Only the newest password works.
  await logOut(page);
  await logIn(page, 'omar.k@example.com', 'a new phrase for tuesday');
  await expect(page.getByRole('alert')).toHaveText('That email and password do not match a Finken account.');
  await page.getByLabel('Password', { exact: true }).fill('the third phrase now');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await greeting(page, 'Omar');
});
