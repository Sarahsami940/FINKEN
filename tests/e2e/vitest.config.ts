import { defineConfig } from 'vitest/config';

// An in-memory Postgres, a real HTTP server and the whole demo data set.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
