// Temporary: run the E2E suite against the installed Google Chrome instead of Playwright Chromium.
import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  use: { ...base.use, video: 'off' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
})
