import { defineConfig } from 'vitest/config';

// Starting an in-memory Postgres takes a few seconds.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
