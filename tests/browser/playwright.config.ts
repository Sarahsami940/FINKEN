/**
 * Finken in a real browser: the app as people use it, browser-only and with
 * an account, plus an accessibility scan of every main screen.
 *
 * Starts its own servers: the API on an in-memory Postgres (invite-only, as
 * the beta is), the web app in
 * browser-only mode, and the web app in account mode. Locally it uses the
 * Edge or Chrome already installed (FINKEN_BROWSER=chrome|msedge); in CI,
 * `npx playwright install chromium` provides one.
 */
import { defineConfig, devices } from '@playwright/test';

const API = 4100;
export const LOCAL_URL = 'http://localhost:5191';
export const ACCOUNT_URL = 'http://localhost:5192';
const channel = process.env.CI ? undefined : (process.env.FINKEN_BROWSER ?? 'msedge');

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { ...devices['Desktop Chrome'], baseURL: LOCAL_URL, channel, trace: 'retain-on-failure', screenshot: 'only-on-failure', timezoneId: 'Asia/Karachi', locale: 'en-GB' },
  webServer: [
    // A closed beta, as in production: helpers.INVITE_CODE lets people in.
    {
      command: 'npm run dev:memory -w @finken/api',
      cwd: '../..',
      env: { PORT: String(API), BETA_ACCESS: 'invite', DEV_INVITE_CODE: 'FNK-TEST-2026', APP_URL: ACCOUNT_URL },
      url: `http://127.0.0.1:${API}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    { command: 'npm run dev -w @finken/web -- --port 5191 --strictPort', cwd: '../..', url: LOCAL_URL, reuseExistingServer: false, timeout: 120_000 },
    // The built app, which has the service worker (offline use and reminders).
    {
      command: 'npm run build -w @finken/web && npm run preview -w @finken/web -- --port 5193 --strictPort',
      cwd: '../..',
      url: 'http://localhost:5193',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'npm run dev:account -w @finken/web -- --port 5192 --strictPort',
      cwd: '../..',
      env: { FINKEN_API_PROXY: `http://127.0.0.1:${API}` },
      url: ACCOUNT_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    // The real sign-in path: an API checking provider tokens, the stand-in provider, and the app sending people to it.
    {
      command: 'npm run dev:memory:sign-in -w @finken/api',
      cwd: '../..',
      env: { PORT: '4101', SIGN_IN_PORT: '4401', WEB_ORIGINS: 'http://localhost:5194', TOKEN_SECONDS: '65' },
      url: 'http://127.0.0.1:4101/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:sign-in -w @finken/web -- --port 5194 --strictPort',
      cwd: '../..',
      env: { FINKEN_API_PROXY: 'http://127.0.0.1:4101', VITE_AUTH_ISSUER: 'http://127.0.0.1:4401' },
      url: 'http://localhost:5194',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
