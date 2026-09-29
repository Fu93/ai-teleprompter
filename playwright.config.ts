import { defineConfig } from '@playwright/test'

// e2e 隔離:main 以 AI_TP_E2E=1 重導 userData 到暫存目錄,測試資料
// (講稿/會議/設定)不會寫進真實使用者資料庫,也不會跟使用者正在跑的
// 實例搶單一實例鎖。
//
// 這裡必須直接改 process.env,不能寫成設定檔的 `env` 欄位 ——
// Playwright 的 TestConfig 沒有頂層 env 欄位,寫上去不會報錯但完全無效,
// 結果就是測試其實寫進了真實的使用者資料。測試檔與 Electron 子程序都跑在
// 同一個 Node 程序下,由這裡設定後子程序會繼承。
process.env.AI_TP_E2E = '1'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  reporter: 'list',
  // 每個測試自行以 _electron.launch 啟動 app,不需要 webServer
  workers: 1
})
