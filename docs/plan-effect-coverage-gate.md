# 「所有 UI/UX 都是有效果的」— 實作計畫與現況

計畫已於本回合被批准。以下是承諾的內容、**已經做完的部分**、以及還沒做完的部分。
「已做完」的定義是:程式碼寫好且通過語法檢查;**「已驗證」的定義是:真的跑過一次稽核並看到輸出**。

## 目標

讓「每個 UI 控制項按下去都真的改變了系統狀態」變成**可強制、可量測、新增時會自己變紅**的閘門,
而不是再寫幾條斷言。原本 `audit:effects` 只問了 11 顆控制項,其餘約 150 顆只有四支 DOM 稽核
量過「存在」(尺寸、對比、可及名稱),而**沒有任何機制會在新增一顆沒被驗過的按鈕時變紅**。

## 一、已完成(程式碼層面)

| 檔案 | 內容 |
|---|---|
| `scripts/lib/effect-inventory.mjs`(新) | 控制項清單 + 狀態清單 + `ENUMERATE()` 頁面內列舉 + 三態對帳規則。113 筆登記(91 顆要探針、22 顆附理由豁免)、20 個宣告狀態 |
| `scripts/lib/fake-media.mjs`(新) | 假麥克風/假攝影機/自動桌面擷取的啟動參數;WAV 標頭與「非靜音」自我驗證(fixture 壞掉不能被誤判成產品缺陷) |
| `scripts/lib/mock-services.mjs`(新) | 本機 mock 雲端 STT(`/audio/transcriptions`)與 mock Ollama(`/api/chat`、`/api/tags`);prompt 全量保留,供「設定真的被帶進請求」的資料層斷言 |
| `scripts/make-audio-fixture.mjs`(新) | 離線產生假麥克風 WAV:Windows 內建語音優先,沒有語音引擎時退回合成波形(並在報告裡誠實標示是哪一種) |
| `scripts/audit-effects.mjs`(大改)| `probe(key, area)` 探針 API:**證據來源必填**(data-layer / other-window / geometry / dom-container),只讀被點元素自己是 `self-evidence` 問題;新增 9 個探針步驟(總覽、講稿、錄音、練習、校準、設定頁開關、對話框、toast、崩潰、浮層工具列)+ `stepInventory()` 覆蓋率對帳 |
| 12 處元件 | `data-effect-id`(動態/重複控制項的穩定身分):模式卡、講稿列、會議列、練習類型/題數、錄影鈕、8 個開關、供應商/引擎/場景/Panic 群、對話框確認與取消、準備度卡片 |

三態對帳規則(這是閘門的核心):

- 列舉到、清單沒有、也沒有豁免 → `no-effect-probe`(紅燈)
- 清單有、列舉到,但這一輪沒有任何結論 → `probe-not-run`(紅燈)
- 清單有、這一輪沒列舉到 → 不報(環境本來就沒渲染它),但會進 `狀態清單` notes

## 二、尚未完成

> 2026-10-01 對帳:1、2、3、5、7 與 6(a–c)已在後續輪次完成(證據見 CHANGELOG 與下述檔案);
> 4 由本輪 CI 接線完成。真正還開著的只剩 6(d) 與 8。

1. ~~跑第一次稽核~~ ✅ 已完成 — 後續跑了多輪,`audit:effects` 連續三次 0 筆(見 CHANGELOG「收斂」一則)。
2. ~~`stepSettingsExtra` 中 `測試連線` 的斷言~~ ✅ 已完成 — audit-effects.mjs 已改為讀回按鈕下方紅字
   (`testError`)、對「失敗文案真的變了」做斷言,不再猜 toast 文案。
3. ~~`release-gate.mjs` 接線~~ ✅ 已完成 — `STEPS` 已含 `audit:journey` / `audit:effects`;`BASELINE` 兩支都有
   (`minStates` 131、`minWorks`、`minControls`、`maxExempt`);`checkAuditBaseline` 已擴充讀 `meta.notes`
   (覆蓋率對帳、四態統計、豁免上限)。
4. ~~`ci.yml` 接線~~ ✅ 已完成(2026-10-01)— 新增獨立 `audit` job:`npm ci` → `build` →
   `make-audio-fixture` → `npm run audit`,六支依序跑、全部擋 merge(未拆平行;job 自己的
   45 分鐘 timeout 足夠,之後要縮時間再拆 matrix);`test:e2e` 封鎖清單已補上
   `transcript-to-script`、`settings-persistence`(16 → 18 個 spec)。
5. ~~`package.json` 新增 `make-audio-fixture` 指令~~ ✅ 已完成。
6. **負向驗證**(四條,這個專案的核心習慣):
   a. ~~加一顆不登記的按鈕 → 必須出現 `no-effect-probe`~~ ✅ — 規則已改嚴(「列舉有、登記沒有 → 紅燈」,
      不管有沒有探針),並真的抓到漏登記十幾輪的「Ollama 位址」(見 CHANGELOG)。
   b. ~~移除已登記控制項 → `probe-not-found`~~ ✅ 已實作(audit-effects.mjs 的 `probe-not-found` 分支 +
      effect-inventory.mjs 的對帳規則),並以「拿掉 `scripts/dirty` 狀態 → `scripts|button|儲存` 立刻紅」驗證過。
   c. ~~探針 onClick 改 no-op → `dead`~~ ✅ — `dead-ui` 偵測在實際輪次抓到過真實案例
      (`practice|button|完成回答,取得反饋`)。
   d. **尚未驗證**:拿掉 `--use-file-for-fake-audio-capture` → 錄音探針必須從 works 變成
      unverifiable(而不是繼續綠)。
7. ~~文件統計數字~~ ✅ 已完成(2026-10-01)— README 單元測試數(377 → 407)、release-gate 橫幅
   「七個步驟」(改為動態 `${STEPS.length}`)都已對齊;CHANGELOG 現況數字本就正確。
8. **已知設計缺口**(維持開著,要誠實列進已知限制):列舉目前只在**單一視窗尺寸**(1280×800)下做;
   響應式隱藏的控制項不會被列舉到。audit-states 已經有雙尺寸的做法可以移植。

## 三、驗證方式

- `node --check` 全部新檔案 ✅
- `npm run build && node scripts/audit-effects.mjs`(第一次會紅,逐項修到規則與現實一致)
- `npm run typecheck && npm test && npm run test:e2e`
- `npm run release`(接線完成後)

## 四、風險

- **假音訊旗標在 Electron 上是否被採用**:假設被採用(playtest3 已證明 `--use-fake-device-for-media-stream` 有效),
  但 `--use-file-for-fake-audio-capture` 是本輪新用。若不被採用,症狀是 mock STT 收到 0 bytes、
  錄音探針報 `dead` —— 那時要改走 main 端 `app.commandLine.appendSwitch`(只在 AI_TP_E2E)而不是改斷言。
- **VAD 門檻**:`AudioSegmenter` 的門檻是 `threshold: 0.01`,而假麥克風的音量取決於 WAV 振幅;
  若太小,段落不會產生 → 錄音探針會紅。已把「fixture 本身是否靜音」先驗掉,所以紅燈只會有一個意思。
- **第一次的紅燈量**:預期「沒有探針」會有數十筆(清單是用原始碼推斷的,不是用 DOM 量的)。
  這正是這個閘門要抓的東西,但需要一輪對帳才會收斂。
