# FlowPrompt「硬核整合」roadmap 的逐條判定(2026-10-05)

> 來源:外部 scratch 目錄的 `flowprompt_hardcore_integration_roadmap.md`
> (Phase 1 DWM 隱形 → 2 生理感知 → 3 臨場感引擎 → 4 發音節奏 → 5 插件/i18n)。
> 判定基準是**這個 repo 的現況**,不是 roadmap 自己描述的 v3。
>
> 兩個前提必須先講清楚,因為它們決定了「移植」的性質:
>
> 1. **`flowprompt-v3` 的原始碼不在這台機器上**(掃過 `C:\Users`、`D:`、`E:`,
>    只有 roadmap 這份 md 與它的 metadata)。所以每一項都是**照規格重寫**,
>    不是檔案級移植。roadmap 列的檔名(`useBioFeedback.js`、`presenceEngine.js`、
>    `useSpeakingMetrics.js`)也與 [archive/INTEGRATION_PLAN.md](archive/INTEGRATION_PLAN.md)
>    的 v3 資產清單對不上 —— 那份清單把 `useFaceMesh` / `useBioFeedback`
>    歸類在「v3 的半成品,不要搬(依賴 jsdelivr CDN)」,而 roadmap 把它們列 P0。
> 2. 本 repo 在 2026-09-27 已經對同一個 v3 做過一次完整盤點
>    ([archive/INTEGRATION_PLAN.md](archive/INTEGRATION_PLAN.md),Phase A–E 全部完成)。
>    這份 roadmap 有三個 Phase 落在當時已經判定過的地方。

## 逐 Phase 判定

| Phase | 判定 | 理由(可查證的) |
| :--- | :--- | :--- |
| 1. DWM 原生隱形 | **不做**(已由平台完成) | 見下方專節 |
| 2. 生理感知(眨眼率 + 4-7-8 呼吸) | **不做**(本輪) | 見下方專節 |
| 3. 臨場感引擎 | **部分做**(2/3 項) | 動態門檻與密度建議已落地;眼神接觸率不做 |
| 4. 發音節奏 | **做**(瞬時 WPM + Ahead/Behind) | 填充詞與語速提示本來就有;本輪補的是 10 秒窗讀數 |
| 5. 插件 + 5 國 i18n | **不做** | 見下方專節 |

### Phase 1 — Electron 已經就是那個「硬核解法」

roadmap 的核心主張是在 main 用 native FFI 呼叫 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`。
但 Electron 官方文件就寫著:`setContentProtection(true)` 在 Windows 上**呼叫的就是**
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`;排除發生在 DWM/核心層。
2026-08 IOActive 對 Signal 的逆向研究把副作用也量清楚了:這個保護**跨進程關不掉**
(連管理員權限都被 ownership check 擋成 `ERROR_ACCESS_DENIED`,唯一繞法是注入到該進程內)。

本 repo 的現況(比 roadmap 假設的完整):

- [windows.ts](../src/main/windows.ts) 對浮層套用 `setContentProtection(o.captureProtected)`,
  預設開啟;設定頁與浮層工具列都有開關。
- 設定頁有「分享前模擬測試」([ipc.ts](../src/main/ipc.ts) 的 `desktopCapturer` 路徑):
  截一張整螢幕縮圖,使用者**當場看到**浮層不在擷取畫面裡 —— 也就是 roadmap 那條
  「特定錄影軟體可能失效」的焦慮,在這個 App 裡有一條自我驗證的路。
- 殘餘風險只有兩個,而且都不是 app 端能解:OS 需 ≥ Win10 2004(build 19041;
  README 已要求 Win10 22H2+/Win11),以及部分 DXGI/direct-GPU 擷取路徑在特定驅動上
  仍看得到(那需要注入進程)。加 `ffi-napi` 只會多一個在 Electron 44 上沒有 ABI
  保證的原生依賴,去重寫一層平台保證。

### Phase 2 — 演算法可行,但缺一個關鍵訊號來源與一個同意流程

- **可行的一半**:本 repo 已經把 MediaPipe 本地化([faceLandmarker.ts](../src/renderer/src/lib/faceLandmarker.ts),
  自帶 wasm/模型、離線可用,目前只用虹膜中心量 IPD)。EAR 眨眼率在同一個 landmarker
  上就能算,而且可以寫成純函數 + 假 landmark 測試。
- **不可行的一半**:roadmap 的觸發條件是「講話中斷 + **高心跳**/高眨眼率」——
  沒有穿戴式裝置就沒有心跳;要從同一個 webcam 做 rPPG 是研究級訊號,不是可依賴的
  觸發源。另外,要整場開相機:會議中 Zoom/Teams 可能已佔用裝置,而本 App 目前
  開相機的時機只有校準與錄影(兩者都是使用者明確按下去的一次性動作)。
  真要做,得先設計一個「生理回饋」的同意與裝置衝突處理 —— 那是獨立的一輪。

### Phase 3 — 兩項落地,一項不做

- ✅ **動態救援門檻** → 重寫為「救援時間預算自適應」:這款 App 的救援沒有自動觸發
  (唯一入口是 hotkey),所以可調的不是觸發門檻而是**產生救援卡的時間預算**。
  見 [context-engine/rescueAdaptation.ts](../src/main/context-engine/rescueAdaptation.ts)。
- ✅ **提詞密度自適應** → 重寫為「密度建議」:由校準語速推導,唯讀顯示在設定頁的
  顯示模式旁。不自動切換,理由見 [densityAdvice.ts](../src/renderer/src/lib/densityAdvice.ts) 檔頭。
- ❌ **眼神接觸率**:需要相機(同 Phase 2),而且這一項在 2026-09-27 就已經以
  「turn-yield 統計 + 語速穩定度」替代並記錄為決策([archive/INTEGRATION_PLAN.md](archive/INTEGRATION_PLAN.md) 的 Phase D)。

### Phase 4 — 落地,並且在過程中抓到一個舊缺陷

- ✅ **瞬時 WPM(10 秒窗)+ Ahead/Behind**:與既有教練共用估計器,
  見 [speakingPace.ts](../src/main/context-engine/speakingPace.ts)。
- ✅ **填充詞**:本來就有([coachingRules.ts](../src/main/context-engine/coachingRules.ts) 的 `countFillers`,
  含 嗯/呃/那個/就是/um/you know/like)。
- 🔍 **順手抓到的舊缺陷**:舊的 60 秒 fast 規則會對慢速語音誤報「語速偏快(800 字/分)」。
  完整記錄在 [UX_FINDINGS.md](UX_FINDINGS.md) 的追加段。
- ⚠️ **與 roadmap 的差異**:roadmap 的 BEHIND 包含「停頓過長」,本輪刻意不含 ——
  停頓有既有的 dead_air 訊號(8 秒、300 秒冷卻),兩者疊在一起會讓「慢慢講」
  被唸兩次。另外 roadmap 的「相對**講稿位置**的 Ahead/Behind」沒有做:
  那需要把 STT 對位(現有 follow 模式的 `sttAligner`)接進即時讀數,
  是另一個規模的工作;本輪的 Ahead/Behind 是**相對個人基準語速**。

### Phase 5 — 與既有決策衝突,而且成本比看起來高

- **插件體系**:2026-09-27 的盤點結論是「v3 只有 2 個場景包,機制過重」,改以
  `assets/packs/*.json` 作為輕量擴充點(現有 8 內建場景 + 2 包)。要做生命周期鉤子
  (`onSessionStart` / `onTranscriptDelta` / `onPanicTriggered` / `onSessionEnd`)
  等於先把現有 main 的單一狀態源拆開 —— 那是一個架構級改動,不是一個模組。
- **5 國 i18n**:UI 文案目前是繁中硬編碼,而**稽核與 e2e 斷言的就是那些中文字串**
  (audit:effects 的 effect key、多支 spec 的 `text=` 選擇器)。先做 i18n 等於先重做
  測試架構 —— 這是為什麼當時的結論是「要上架發布再遷」,而現在的成本更高。

## 本輪實際實作(可驗證)

| 項目 | 檔案 | 守衛 |
| :--- | :--- | :--- |
| 瞬時語速估計器 + ±10% 判定 + 中位數濾波 | `src/main/context-engine/speakingPace.ts` | `speakingPace.test.ts`(19) |
| 發送政策(鍵變才送 / 心跳 / null 只送一次) | 同上 | 同上(4 條) |
| main 端接線(段落 + 2 秒心跳 + 場次重置) | `src/main/liveCoaching.ts` | 接線守衛(源碼掃描)+ e2e |
| IPC / preload / 型別 | `CoachingPace: 'context:coaching-pace'` | 三份 typecheck |
| 浮層讀數 chip(展開態、8 秒過期清掃) | `usePace.ts` + `OverlayApp.tsx` | `e2e/overlay-pace.spec.ts`(真 IPC) |
| 救援預算自適應 | `src/main/context-engine/rescueAdaptation.ts` | `rescueAdaptation.test.ts`(13) |
| 密度建議 | `src/renderer/src/lib/densityAdvice.ts` + `SettingsPage.tsx` | `densityAdvice.test.ts`(7) |
| 舊 fast 假陽性修正 | `src/main/context-engine/coachingRules.ts` | 逐次斷言的測試 + 負向驗證 |

四組負向驗證(拿掉修法 → **對的**斷言轉紅):估計器的 3 秒下限、e2e 的送讀數接線、
救援預算的放寬、密度建議的快讀者分支。

## 已知限制(不假裝它們不存在)

- **估計器是「送達密度」不是音訊時長**:長句停頓後才送達時瞬時值會偏高。
  它是趨勢讀數,不是報告數字(會後報告走逐字稿的真實時長)。
- **讀數只在展開態浮層出現**:藥丸(320px 扣三顆按鈕)與貼鏡(420×170,高度預算
  被量過三次)沒有空間給一個持續讀數。這是刻意取捨,寫在 `OverlayApp.tsx` 該處註解。
- **密度建議只看校準值**,不看逐場統計(逐場要先把場合正規化)。
- **救援預算只放寬**:收緊唯一的效果是把「偶爾慢」變成「偶爾失敗」。
- **眼神接觸率、呼吸導引、插件鉤子、i18n 都沒有做** —— 理由見上表。
