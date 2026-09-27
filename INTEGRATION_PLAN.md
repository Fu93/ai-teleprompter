# FlowPrompt → AI 提詞機 整合方案

> 產出日期:2026-09-27。分析基準:`flowprompt`(v1 原型)、`flowprompt-v3`(v13.0.2,33k LOC / 31 測試檔)、本地 `ai-teleprompter` v0.1.0(TS 重寫版)。

---

## 一、三個專案盤點

| | flowprompt (v1) | flowprompt-v3 | ai-teleprompter(本地新專案) |
|---|---|---|---|
| 定位 | 單檔原型(已停維護) | Cluely 對標完整版 | TS 重寫版(進行中) |
| 技術棧 | Electron + 原生 JS | Electron 34 / React 18 / JS ESM | **Electron 44 / React 19 / TypeScript / Tailwind 4** |
| 狀態 | 歸檔,不再投入 | 功能水庫(供移植) | **整合基底** |

### 新專案目前已有
- 主進程:設定讀寫、透明置頂浮層視窗、全域熱鍵、滑鼠穿透、`setContentProtection`(螢幕分享隱形)、**系統音訊 loopback 授權**(`setDisplayMediaRequestHandler` + `audio: 'loopback'`,Windows 可用)
- AI:Ollama chat(可 abort)+ OpenAI 相容雲端設定
- Renderer:Dashboard、Scripts(CRUD + 開始提詞)、SettingsPage(354 行)、OverlayApp(單模式連續捲動提詞器)
- 資料層:Dexie(Script / MeetingSession / PracticeRun 型別已定義)、Zustand store
- 剛建立:`lib/audio/segmenter.ts`(能量 VAD 分段器,尚無人使用)
- 佔位頁:Record(Phase 5)、Practice(Phase 7)

### v3 的成熟資產(有測試、生產級)
| 模組 | 檔案 | 內容 |
|---|---|---|
| 純函數工具組 | `overlay/utils/*` | semantic-chunker(語義切塊)、sentenceSplitter(縮寫感知斷句)、bulletGenerator(大綱→要點)、sttAligner(Levenshtein 模糊對齊)、modeTransforms、coachingRules(教練規則引擎) |
| 三模式定時引擎 | `overlay/hooks/unifiedTimingEngine.js`(852 行) | 單一 RAF scheduler,Phrase / Karaoke / Bullet 三 adapter,938 行測試 |
| STT 管線 | `main/modules/stt.js`(612 行) + `localStt.js` + `localVad.js` | Deepgram 雙聲道 diarization(mic=ch0 使用者 / 系統音=ch1 對方)+ sherpa-onnx 本地串流 STT + Silero VAD turn-yield(`TURN_CANDIDATE` / `SPEAKING_PEER_SILENCE`) |
| AI Provider 抽象 | `main/modules/aiProvider.js` | OpenAI / Anthropic / Groq / Ollama 統一介面、safeStorage 加密金鑰、SSRF 防護、provider 偵測 |
| Panic 救援 + 場景 | `main/modules/context-engine/` | 8 種場景 preset(面試/銷售/投資人/播客…)、PanicOrchestrator(1.5s cooldown、AI 失敗退模板、AI vs 模板統計) |
| Session Intelligence | `main/modules/session-intelligence/` | SessionReport / 1s Timeline(WPM、眼神接觸、卡頓)/ PersonalProfile 滾動聚合、建議生成 |
| 隱身模組 | `main/invisibility/` | 4 狀態宣告式可見性(normal/stealth/passthrough/hidden) |
| 場景包 | `assets/packs/*.json` | interview-essentials、sales-classic——**純 JSON,可直接複用** |
| i18n / 快捷鍵 / 匯出 | `control/i18n/`、`shortcuts/`、`export.js` | 5 語系 316 keys、Alt+Space 系列熱鍵、Markdown 會議筆記 |

### v3 的半成品(**不要搬**)
- `useFaceMesh` / `useBioFeedback`(依賴 jsdelivr CDN 動態載入,離線不可用)
- `useRecordingSynthesizer`(五軌錄製,半途而廢)
- `plugin-system`(只有 2 個場景包,機制過重)
- `license.js`(純客戶端 HMAC,無伺服器驗證,形同虛設)
- 系統音訊擷取的 producer(從未完成——但**新專案已完成這塊**,見下)
- Windows permissions 檢查(stub)

### v1 的唯一價值
已被 v3 全面取代;`vad-worker.js` 的問句判定模式(`QUESTION_PATTERNS` → turn confirmation)在 v3 的 `vad.js` 仍有參考實作。其餘歸檔即可。

---

## 二、整合策略結論

**以 `ai-teleprompter` 為唯一基底,v3 作為功能捐贈者逐模組 TypeScript 化移植;v1 歸檔不動。**

決定性理由:
1. **技術棧代差**:Electron 44 vs 34、React 19 vs 18、TS vs JS。舊棧只會越來越難維護。
2. **新專案獨有 v3 缺的關鍵拼圖**:Windows 系統音訊 loopback 已通。v3 的雙聲道 diarization 因缺 producer 而殘廢——兩邊拼起來才等於完整 Cluely 能力(對方說話也轉錄、知道何時輪到你)。
3. v3 的測試覆蓋集中在純函數與狀態機,**這些正是最容易移植的部分**;深度耦合視窗/IPC 的部分本來就需要按新架構重寫。

移植原則:
- 每個模組以 TS 重寫 + 帶上 v3 原測試(遷移到 vitest),不是複製貼上
- 延續 v3 的三條設計紀律:IPC channel 集中定義(`shared/types.ts` 的 `IPC` 已在做)、main 為單一狀態源寫入即廣播、renderer 只拿最小 preload surface
- 型別先行:所有移植模組先補 `shared/types.ts` 契約,再寫實現

---

## 三、分階段施工圖

### Phase A — 浮層升級:三顯示模式(純前端,零風險)✅ 已完成(2026-09-27)

> **實施記錄**:已全部落地。
> - `src/renderer/src/lib/teleprompter/`:sentenceSplitter / semanticChunker / bulletGenerator / modeTransforms / sttAligner(constants.ts 為 PhraseVisuals + PhraseChunkingRules)全數 TS 化,CJK 短語組合不加空格(優於 v3 的 join(' '))
> - `engine.ts`:TS 版四模式定時引擎(單一時鐘、tick(now) 注入式、防跳幀夾制、剩餘時間估算、progress 計算)
> - `scriptModel.ts`:一份講稿一次加工出四模式資料
> - `overlay/useTeleprompterEngine.ts`:RAF 層(離散變更立即 render、連續變更節流 5Hz、scroll 每幀直寫 DOM)
> - `OverlayApp.tsx`:四模式切換工具列 + 鍵盤控制(空白鍵播放、← → 翻 bullet),並**併入語音跟讀**(scroll 模式限定,與定時引擎互斥:跟讀啟動時自動暫停捲動)
> - 設定:`displayMode`(scroll/phrase/karaoke/bullet)+ `rate`(0.5–3×)加入 OverlaySettings;SettingsPage 有選擇器與滑桿
> - 測試:vitest 5 已導入,6 檔 86 測試全綠(v3 的 71 個案例遷移 + 15 個引擎新案例);typecheck 與生產建置通過

把 OverlayApp 從「單一連續捲動」升級為 v3 的三模式:
1. 移植 `sentenceSplitter` → `semantic-chunker` → `modeTransforms` / `bulletGenerator`(全部純函數,直接 TS 化)
2. 以 v3 `unifiedTimingEngine` 為藍本寫 TS 版 `useTimingEngine`:單一 RAF loop + mode adapter(現有 rAF 捲動邏輯退位)
3. Overlay 設定加 `displayMode: 'scroll' | 'phrase' | 'bullet' | 'karaoke'`,現有行為保留為 `scroll` 模式
4. `sttAligner` 此時先移植不接線(Phase B 才有 transcript 來源)

**驗收**:同一份講稿四種模式可切換,播放/暫停/速度/剩餘時間全模式可用。

### Phase B — 音訊管線:會議即時轉錄(新專案 loopback × v3 管線架構)
這是兩個專案合體價值最大的一步:
1. `AudioSegmenter`(已有)接 mic;新增第二條 loopback stream 接系統音(利用現有 `setDisplayMediaRequestHandler`)
2. 移植 v3 `createStereoMixer` + `SpeakerMap` 思路:兩條 stream 分別轉錄後標 `speaker: 'me' | 'them'`(新專案 `TranscriptSegment` 型別已就位)——不必真合成雙聲道,分開送更簡單
3. STT 引擎雙路徑:
   - 雲端:Groq `whisper-large-v3`(SttSettings 已定義)吃 segmenter 切出的段
   - 本地:評估 sherpa-onnx-node(Electron 44 ABI 需 rebuild)或 whisper.cpp / transformers.js WebGPU,**決策點見第五節**
4. 移植 v3 turn-yield 邏輯:segmenter 的 `minSilenceMs` 靜音事件 + `QUESTION_PATTERNS`(對方問句結尾)→ 發 `TURN_CANDIDATE` → 浮層顯示「該你說話了」提示(對應 v3 的 useVAD/usePanicButton UI)
5. `Record.tsx` 落地:即時雙欄逐字稿(me/them)+ 停止後用現有 `OllamaChat` 生成摘要(abstract/keyPoints/todos/followUps,`MeetingSummary` 型別已定義)+ Markdown 匯出(現有 `ExportFile` IPC)

**驗收**:開一場 Google Meet,對方與自己的話分欄即時出現,停止後產出會議摘要。

### Phase C — Panic 救援 + 場景引擎(核心差異化)✅ 已完成(2026-09-27)

> **實施記錄**:已全部落地,61 個新測試(總 147 全綠)。
> - `src/main/ai/`:providerRegistry(OpenAI/Anthropic/Groq/Ollama/自訂 OpenAI 相容,純函數)+ providerDetection(key 前綴偵測)+ ollamaEndpoint(SSRF 防護)+ aiProvider(safeStorage 加密金鑰 `userData/keys.enc`、統一 `chatCompletion`、`testConnection`)
> - `src/main/context-engine/`:scenes(8 場景全文 + 中英追問分類 + ConversationTracker)+ panicAi(v3 prompt 全文、3 段式解析、啟發式 confidence)+ orchestrator(1.5s cooldown、3s 失敗退避、AI/template 統計、per-window registry)
> - `src/main/liveContext.ts`:轉錄環形緩衝(500→200 裁切、120s 時間窗、them 話語優先);`src/main/packs.ts`:場景包載入器(bundled + userData/packs),`assets/packs/` 已複製 v3 兩包
> - 接線:`ai:chat-completion` / `ai:test-connection` / `ai:keys-get|set` / `scene:list` / `context:push-transcript` / `panic:trigger` IPC;**Alt+P 全域熱鍵**(可改 Alt+/ 或 F9);panic 時浮層自動顯示
> - 浮層:Siren 按鈕 + RescueCard(12s 自動消失、信心色條 ≥0.6 綠 / ≥0.3 橙、AI/模板標籤、出卡自動暫停提詞);語音跟讀轉錄已接 liveContext(panic 上下文來源),無語音時退用目前講稿結尾
> - 設定:AI 助理頁新增場景選擇(含 pack 場景)、面試/會議 framing 切換、AI 即時救援開關;`scenario` 設定區塊 + `panicRescue` 熱鍵加入 defaults
> - 相容:既有 `ai:ollama-chat` / `ai:openai-chat` 通道保留(Record/Practice 繼續用);金鑰改存 safeStorage 後設定頁明文欄位仍為 fallback

1. 移植 `aiProvider` → TS 版 `aiProvider.ts`:多 provider 統一介面、safeStorage 金鑰加密(取代現在明文存設定)、Ollama endpoint SSRF 防護;保留新專案的串流能力
2. 移植 `context-engine`:8 場景 preset、`buildPanicSystemPrompt`、三段式救援解析(JSON → regex → 模板 fallback)、cooldown / in-flight 守衛
3. 直接複製 `assets/packs/*.json` 進新專案 `assets/packs/`(schema 已相容,只需 TS 型別)
4. 浮層加 Panic 熱鍵(建議 Alt+/ 或跟 v3 用同一顆):即時顯示 AI 救援卡(sentence + points,12s 自動淡出)
5. `Scripts.tsx` / 設定頁加場景選擇器

**驗收**:面試中被問倒,按熱鍵 1.5 秒內浮層出現可用的回答要點;斷網時退場景模板不出白屏。

### Phase D — Session Intelligence + 面試練習
1. 移植 session-intelligence 三層模型(SessionReport / Timeline / PersonalProfile)→ Dexie tables(取代 electron-store,單一儲存技術)
2. 轉錄會話期間 1s 取樣:由 transcript 時間戳算 WPM;Phase B 的 turn-yield 統計代替 v3 的 eyeContact(眼神追蹤不搬)——卡頓、話量比、搶話/冷場
3. 會後報告:PostSessionModal 概念 → `Record.tsx` 會後面板(四格統計 + 0–3 條建議 + profile 回寫)
4. `Practice.tsx` 落地:用場景包模板 + 現有 Ollama 出題 → 麥克風作答(segmenter → STT)→ `PracticeFeedback`(score/內容/結構/表達/改寫示範)——型別已定義,配合 `coachingRules` 引擎給即時提示
5. Dashboard 接上跨 session 趨勢(WPM / 答題分數曲線)

**驗收**:完整走一場模擬面試,事後有量化報告且 Dashboard 曲線更新。

### Phase E — 產品化收尾
1. 隱身 4 狀態統一(把現有 clickThrough + captureProtected 合併為 v3 式 `VisState` 宣告式配置)
2. 快捷鍵全家桶:Alt+Space 播放暫停 / Alt+↑↓ 速度 / Alt+H 隱藏 / Alt+P 控制台(沿用 v3 衝突處理:warn + 略過)
3. i18n:搬 v3 的 5 語系結構(自製 useI18n,零依賴),zh-TW 為 fallback
4. e2e:Playwright `_electron.launch` 走真 IPC 鏈(參考 v3 `e2e/teleprompter-flow.spec.js`)
5. electron-builder 打包(NSIS),注意原生模組 asarUnpack

---

## 四、階段相依與里程碑

```
Phase A(浮層三模式)──┐
                      ├─→ Phase C(Panic+場景)→ Phase D(SI+練習)→ Phase E
Phase B(音訊+轉錄)───┘
```
A、B 互相獨立可並行;C 需要 A 的浮層 UI 與 B 的 transcript(部分);D 依賴 B 的取樣資料;E 收尾。先做 A(最小、可立即驗證、建立移植測試慣例),再攻 B。

## 五、需要拍板的決策點

1. **本地 STT 技術選型**(影響 Phase B 路線):
   - `sherpa-onnx-node`:v3 已驗證的方案,串流低延遲,但原生模組 + Electron 44 ABI 需驗證,打包要 asarUnpack
   - whisper.cpp( node addon )或 transformers.js(WebGPU):無原生模組負擔,但非串流、延遲高
   - 建議:先雲端(Groq)落地 Phase B,本地 STT 作為並行分支驗證 sherpa-onnx × Electron 44,通了再切
2. **眼神/生理回饋(useFaceMesh 系)**:建議整組放棄(CDN 依賴 + 實驗性),Session Intelligence 改用語音/對話訊號;未來要再加再議
3. **是否需要授權機制**:v3 的 client-only license 建議不搬;若要商業化再設計 server-side

## 六、立即下一步(建議)

Phase A 第 1 步:移植四個純函數工具 + 三模式定時引擎 TS 化,並把 v3 對應測試一併遷移——預計一次提交可完成,浮層立刻有感升級。
