# AI 提詞機（對標 Cluely）實作計畫

## 產品定位

依你選定的三大場景打造的桌面應用（Windows 優先）：

1. **提詞浮層** — 貼上講稿、平滑滾動、永遠在最上層的透明浮動視窗，適合演講/錄影/直播；可切換「螢幕擷取隱形」
2. **會議錄音轉錄＋AI 筆記** — 即時錄音轉文字（區分你/對方聲道），會後 AI 生成摘要、重點、待辦，可匯出 Markdown
3. **面試練習教練** — AI 出題（語音朗讀），你用麥克風回答，AI 針對內容、結構、語速、填充詞給反饋與評分

AI 全部走**本地 Ollama（免費離線）**；語音辨識**本地 Whisper 與雲端 API 可切換**。

## 技術架構

| 層 | 選型 | 理由 |
|---|---|---|
| 框架 | Electron 31+ / electron-vite / React 18 / TypeScript / Tailwind CSS | 覆蓋層、系統音訊迴路、防擷取皆原生支援 |
| 本地 LLM | Ollama（HTTP localhost:11434） | 你選的免費方案；介面做成 OpenAI 相容抽象層，日後填 base URL + key 即可接任何雲端 |
| 本地 STT | @huggingface/transformers（transformers.js v4）跑 Whisper + WebGPU | 純 JS、模型自動下載快取（tiny/base/small 可選）、無需 Python |
| 雲端 STT | OpenAI 相容 `/audio/transcriptions` 介面（Groq 免費額度即可用）＋預留 Deepgram 串流 | 可切換設計 |
| VAD | @ricky0123/vad-web（silero） | 語音分段、降噪觸發轉錄 |
| 音訊 | getUserMedia（麥克風）＋ desktopCapturer loopback（系統音訊，Windows） | 會議雙聲道 |
| TTS | Web Speech API | 面試官朗讀題目，免費、Windows 內建中文語音 |
| 資料 | Dexie（IndexedDB）＋ JSON 設定檔 | 零原生模組，存講稿/逐字稿/練習紀錄 |
| 打包 | electron-builder（NSIS 安裝包） | — |

### 視窗規劃
- **主控制台**：模式入口（提詞/錄音/練習）、講稿庫、歷史紀錄、設定（模型下載、Ollama 狀態、STT 切換、熱鍵）
- **提詞浮層**：無邊框、透明、置頂、可拖曳縮放、滑鼠穿透切換、鏡像模式、字體/速度/倒數計時、`setContentProtection` 隱形切換
- **隱藏音訊視窗**：承載音訊管線與 STT worker

## 分階段實作（每階段結束都可執行驗收）

**Phase 1 — 專案骨架**：electron-vite 腳手架、主/渲染/preload IPC 架構、路由、Zustand 設定存取、深色主題 UI 框架、全域熱鍵註冊。

**Phase 2 — 提詞浮層**：置頂透明視窗（拖曳/縮放/穿透/隱形切換）、講稿貼上與匯入（txt/md）、rAF 平滑滾動引擎（速度/字級/行距/鏡像/倒數計時）、主畫面講稿庫管理。

**Phase 3 — 音訊管線＋本地轉錄**：麥克風擷取、VAD 分段、transformers.js Whisper 整合（模型管理 UI 含下載進度）、即時逐字稿顯示。

**Phase 4 — 語音跟讀提詞**（殺手級功能）：逐字稿與講稿模糊比對，自動捲動跟著你的語速走、當前行高亮——先進階提詞機的招牌功能。

**Phase 5 — 錄音會議模式**：錄音/暫停、系統音訊 loopback 擷取（Windows）、雙聲道即時逐字稿、工作階段存檔與匯出 md/txt。

**Phase 6 — Ollama AI 層＋會議摘要**：Ollama 偵測與安裝引導、模型清單自動取得與選擇、會後摘要（摘要/重點/待辦/追問建議）、通用 OpenAI 相容供應商設定頁（日後接雲端）。

**Phase 7 — 面試練習模式**：職位/題型設定、AI 生成題庫、TTS 朗讀題目、語音作答即時轉錄、逐題反饋＋總評評分、練習歷史。

**Phase 8 — 打磨與打包**：完整設定頁、全域熱鍵（顯示/隱藏浮層等）、UI 細節、electron-builder 打包成 Windows 安裝包。

## 你需要準備的
- 安裝 [Ollama](https://ollama.com/)（Phase 6 前裝好即可，屆時 app 會自動偵測並引導；建議拉 `qwen2.5:7b` 以上模型，中文表現好）
- 首次使用本地轉錄時，app 內下載 Whisper 模型（tiny 約 75MB，small 約 500MB）

## 風險與備註
- 專案位於 OneDrive 資料夾，`node_modules` 數萬小檔案會拖慢同步，建議將此資料夾加入 OneDrive 排除清單（安裝完依賴後我會提醒）
- 系統音訊 loopback 僅 Windows 支援（你的平台沒問題）；macOS 需虛擬音訊裝置，之後如需跨平台再處理