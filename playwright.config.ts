import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser', fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4188', headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'npx tsx test/browser-server.ts', url: 'http://127.0.0.1:4188/api/state', reuseExistingServer: false, timeout: 30_000 }
});
