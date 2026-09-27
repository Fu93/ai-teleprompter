import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  reporter: 'list',
  // 每個測試自行以 _electron.launch 啟動 app,不需要 webServer
  workers: 1
})
