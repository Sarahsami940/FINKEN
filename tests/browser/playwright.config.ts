/**
 * Finken in a real browser: the app as people use it, browser-only and with
 * an account, plus an accessibility scan of every main screen.
 *
 * Starts its own servers: the API on an in-memory Postgres, the web app in
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
    { command: 'npm run dev:memory -w @finken/api', cwd: '../..', env: { PORT: String(API) }, url: `http://127.0.0.1:${API}/health`, reuseExistingServer: false, timeout: 120_000 },
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
  ],
});
