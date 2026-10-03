/**
 * manifest.mjs — 「e2e 要跑哪些」的唯一出處。
 *
 * ── 為什麼需要這份檔案 ──
 *   探索這個 repo 時發現,同一個問題有三份互相獨立的答案:
 *     1. package.json 的 test:e2e —— 19 支
 *     2. package.json 的 test:all —— 走 e2e,全 20 支
 *     3. scripts/release-gate.mjs 的 STEPS —— 走 npx playwright test,全 20 支
 *   也就是說:本地閘門擋的東西比 CI 多一支,而「差哪一支、為什麼」沒有任何
 *   地方寫著。這不是未來的風險,是此刻已經存在的漂移。
 *
 *   集中到一份清單解決的是「有一份來源」。真正防止它再次分裂的是
 *   `src/renderer/src/lib/__tests__/e2eManifest.test.ts` —— 它斷言
 *   **每一支 spec 恰好出現在一份清單裡**,新增一支沒登記就紅燈。
 *
 * ── 為什麼是 .mjs 而不是 .ts ──
 *   package.json 的 script 與 release-gate.mjs 都是 .mjs,而 vitest 的
 *   include 是 src 底下以 .test.ts 結尾的檔案。用 .mjs 讓三邊都能直接
 *   import 它,不需要任何建置步驟 —— 若這份清單需要先編譯才能讀,那就多了一個
 *   「忘了重建」的失敗模式。
 *
 * ── 為什麼存檔名而不是路徑 ──
 *   'e2e/smoke.spec.ts' 與 'smoke.spec.ts' 混用時,產生命令列的方式會有
 *   兩套,而其中一套必然漏掉某些檔。清單測試也釘住這一點。
 */

/**
 * 擋 merge 的封鎖套件。
 *
 * 標準:這條測試在**任何**環境都必須穩定通過,包括 CI runner。
 * 已知的環境相依(Chromium 對視窗尺寸的量化、1 像素的字型度量差異)
 * 應該由測試本身容錯,而不是靠「放到 advisory 就不會擋人」。
 */
export const BLOCKING_SPECS = [
  'smoke.spec.ts',
  'user-journey.spec.ts',
  'error-boundary.spec.ts',
  'confirm-close.spec.ts',
  'settings-persistence.spec.ts',
  'backup.spec.ts',
  'scripts-import.spec.ts',
  // 講稿不能因為使用者忘了按「儲存」而消失。特別是 Ctrl+S:它沒有接的時候
  // 症狀是「什麼事都沒發生」,使用者會合理地以為自己存過了(見檔頭)
  'script-autosave.spec.ts',
  'transcript-to-script.spec.ts',
  // 錄音中退出不能靜默清空整場會議(before-quit 會繞過視窗守衛,
  // autoInstallOnAppQuit 又讓「更新完退出」是常見路徑 —— 見 quit-flush.spec.ts 檔頭)
  'quit-flush.spec.ts',
  // 錄影提詞原本一道守衛都沒有(關窗/離頁/退出前 flush/阻擋睡眠全部缺席),
  // 而它的資料是整段攢在記憶體裡的 —— 見 e2e/video-recording.spec.ts 檔頭
  'video-recording.spec.ts',
  'practice-generation.spec.ts',
  'preflight.spec.ts',
  'mic-denied.spec.ts',
  'blindspot.spec.ts',
  'calibration-escape.spec.ts',
  'debug-panel.spec.ts',
  'overlay-hide-follow.spec.ts',
  'overlay-script-sync.spec.ts',
  'pill-notice.spec.ts',
  'pill-progress.spec.ts',
  'pill-scale.spec.ts',
  'playtest3.spec.ts',
  'visual.spec.ts'
]

/**
 * 嘗試執行但**不擋 merge** 的測試。
 *
 * 每一支都必須寫明「為什麼不擋」—— 沒有理由的 advisory 會在半年後被當成
 * 「忘了放進 blocking」而升級,於是它開始製造假紅燈,而那正是它被分類
 * 出來要避免的東西。
 */
export const ADVISORY_SPECS = [
  {
    file: 'meeting-flow.spec.ts',
    reason:
      '時序敏感的演示 spec:它逐段推送訊號並截圖,依賴浮層在特定時間點的狀態。' +
      '在 CI runner 上偶發超時,而它的產物是截圖(不是斷言),所以「紅了」也' +
      '不代表有功能缺陷 —— 但反過來說,它綠的時候也不能證明什麼。' +
      '它仍然會跑,而且報告一定會被上傳(見 ci.yml 的上傳條件)。'
  }
]

/** 兩份清單合起來的檔名清單(供完整性測試比對磁碟)。 */
export const ALL_SPECS = [...BLOCKING_SPECS, ...ADVISORY_SPECS.map((s) => s.file)].sort()

/**
 * 給人看的分類說明。
 *
 * 存在的理由:當有人在 CI 上看到「17 passed、1 failed」而那 1 支不在
 * blocking 裡,他們需要知道那是**刻意的**,不是漏掉的。
 */
export function describeE2E() {
  return {
    blocking: [...BLOCKING_SPECS].sort(),
    advisory: ADVISORY_SPECS.map((s) => ({ ...s })).sort((a, b) => a.file.localeCompare(b.file))
  }
}

/** 產生 blocking 套件的 Playwright 檔案參數。 */
export function blockingArgs() {
  return BLOCKING_SPECS.map((f) => `e2e/${f}`)
}

/** 產生 advisory 套件的 Playwright 檔案參數。 */
export function advisoryArgs() {
  return ADVISORY_SPECS.map((s) => `e2e/${s.file}`)
}
