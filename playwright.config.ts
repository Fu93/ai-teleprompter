import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  reporter: 'list',
  // 每個測試自行以 _electron.launch 啟動 app,不需要 webServer
  workers: 1,
  // e2e 隔離:main 以 AI_TP_E2E=1 重導 userData 到暫存目錄,
  // 測試資料(講稿/會議/設定)不會寫進真實使用者資料庫
  env: {
    ...process.env,
    AI_TP_E2E: '1'
  } as Record<string, string>
})
