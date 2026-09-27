# AI 提詞機

對標 [Cluely](https://cluely.com/) 的桌面提詞機，三大模式：

1. **提詞浮層** — 講稿平滑滾動、永遠置頂的透明浮動視窗。支援**語音跟讀**（唸到哪、捲到哪）、鏡像模式、**螢幕擷取隱形**（視訊分享與錄影看不到浮層）、滑鼠穿透。
2. **錄音轉錄** — 即時逐字稿（麥克風＝「我」、系統音訊＝「對方」），會後 **AI 摘要／重點／待辦／跟進建議**，匯出 Markdown。
3. **面試練習** — AI 依職位出題並朗讀（TTS），用麥克風回答，AI 針對內容／結構／表達反饋評分＋示範回答，最後整體總評。

## 技術棧

- Electron 44 + React 19 + TypeScript + Tailwind CSS 4（electron-vite）
- 語音辨識：本地 [transformers.js](https://github.com/huggingface/transformers.js) Whisper（WebGPU 加速、完全離線）或雲端 OpenAI 相容 API（如 Groq 免費額度）可切換
- AI：本地 [Ollama](https://ollama.com/)（預設）或任何 OpenAI 相容 API
- 資料：IndexedDB（Dexie），設定存於 `%APPDATA%/ai-teleprompter/settings.json`

## 開發

```bash
npm install        # Node 20+；Electron 二進位沒下載成功時執行：node node_modules/electron/install.js
npm run dev        # 開發模式
npm run typecheck  # 型別檢查
npm run build      # 建置
npm run dist       # 打包 Windows 安裝包（NSIS，輸出至 dist/）
```

## 使用前準備

- **AI 功能**：安裝 [Ollama](https://ollama.com/download) 後執行 `ollama pull qwen2.5:7b`（中文表現佳；記憶體不足可改 `qwen2.5:3b`）。設定頁可測試連線並選擇模型。
- **本地語音辨識**：首次使用會自動下載 Whisper 模型（tiny 75MB / base 145MB / small 500MB），之後離線可用。
- **熱鍵**：`Ctrl+Alt+T` 顯示／隱藏浮層，`Ctrl+Alt+H` 隱藏。可在設定頁更換。

## 注意

- 本專案位於 OneDrive 資料夾，建議將 `對標提詞機` 加入 OneDrive 排除清單（`node_modules` 數萬小檔案會拖慢同步）。
- 系統音訊擷取（聽到會議對方的聲音）目前僅 Windows 支援。
