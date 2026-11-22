import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const LOCAL_URL = 'http://localhost:5191';
export const ACCOUNT_URL = 'http://localhost:5192';
/** The built app, with its service worker. */
export const BUILT_URL = 'http://localhost:5193';
/** The test API is a closed beta; this code lets anyone in (see playwright.config.ts). */
export const INVITE_CODE = 'FNK-TEST-2026';
/** The password every test account uses: long enough, and not a common one. */
export const TEST_PASSWORD = 'tea by the river at four';

/** Creates a Finken account from the welcome screen (Finken's own sign-in). */
export async function signUp(page: Page, email: string, name: string, password = TEST_PASSWORD) {
  await page.getByRole('button', { name: 'Get Started' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Type the password again').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

/** Account mode with the real sign-in path, and the stand-in sign-in provider it uses. */
export const SIGN_IN_URL = 'http://localhost:5194';
export const SIGN_IN_PROVIDER = 'http://127.0.0.1:4401';

/** Reads "Rs. 2,665,000" or "Rs. 1,250.50" as paisa. */
export function paisa(text: string): number {
  const m = text.replace(/\s/g, '').match(/(-?)Rs\.?(-?)([\d,]+)(?:\.(\d{1,2}))?/);
  if (!m) throw new Error(`No amount in "${text}"`);
  const sign = m[1] || m[2] ? -1 : 1;
  return sign * (Number(m[3].replace(/,/g, '')) * 100 + Number((m[4] ?? '').padEnd(2, '0')));
}

/** Opens the demo as a guest, in the Personal Space. */
export async function enterAsGuest(page: Page, origin = LOCAL_URL) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Try Finken' }).click();
  await page.getByRole('button', { name: /Open the demo|Start|Continue|Enter/ }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

/** Total available money on the Money page. */
export async function availableMoney(page: Page): Promise<number> {
  await page.goto(`${new URL(page.url()).origin}/money`);
  const total = page
    .locator('section', { hasText: 'Available money' })
    .getByText(/^Rs\. [\d,.]+$/)
    .first();
  await expect(total).toBeVisible();
  return paisa(await total.innerText());
}

export interface Finding {
  screen: string;
  rule: string;
  impact: string;
  help: string;
  where: string[];
  detail?: string;
}

/**
 * Serious and critical problems axe finds on the page as it is now. (axe brings its own copy of
 * Playwright's types, a newer one; the page is the same object, hence the cast.)
 */
export async function scan(page: Page, screen: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ screen, rule: v.id, impact: v.impact!, help: v.help, where: v.nodes.map((n) => n.target.join(' ')).slice(0, 6), detail: v.nodes[0]?.any[0]?.message }));
}

export const describeFindings = (findings: Finding[]) =>
  findings.map((f) => [`${f.screen}: ${f.rule} (${f.impact}) ${f.help}`, `    ${f.detail ?? ''}`, ...f.where.map((w) => `    at ${w}`)].join('\n')).join('\n');

/** Fails on anything serious or critical, listing each with where it is. */
export async function expectAccessible(page: Page, screen: string) {
  const findings = await scan(page, screen);
  expect(findings.length, describeFindings(findings)).toBe(0);
}
