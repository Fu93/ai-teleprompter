# UI/UX 問題清單(2026-10-03)

> 這份清單的起點是一個不太舒服的事實:六支稽核(`audit:ui` / `audit:deep` /
> `audit:states` / `audit:journey` / `audit:glass-edge` / `audit:effects`)在
> 同一天全部回報 **0 problems**。也就是說,下面這些問題都不是「稽核壞了」,
> 而是**稽核量不到的類別**。
>
> 每一條都寫明:症狀 → 證據(檔案:行)→ **為什麼現有稽核量不到** → 修法 → 驗收。
> 「為什麼量不到」那一欄是這份文件存在的理由:沒有它,下一次還是只會修被量到的東西。

稽核量的是幾何、對比、命中區、覆蓋、狀態是否到達、材質邊緣。它們量不到的是:

1. **重複的資訊架構** —— 兩張卡在講同一件事,幾何上各自完全合法
2. **揭露方式** —— `title` 原生 tooltip 在可及名稱規則裡是合格的名稱,所以「只有
   hover 才看得到」永遠不會被報出來
3. **狀態的可辨識性** —— 兩個狀態用同一個色相的 20% 不透明度差,對比度檢查逐元素看,看不出「這兩個是不同狀態」
4. **格式化後的荒謬值** —— `-0:00` 是一個合法字串,沒有任何規則比對語意
5. **動線的終點** —— journey 稽核記下了「無講稿時顯示浮層的按鈕:(無)」卻沒有把它當成缺陷(它問的是「有沒有到得了」,不是「該不該到得了」)
6. **可尋性** —— 10 個區塊的單一長捲動頁面,每一個區塊都合格,合起來找不到東西

範圍:主視窗六頁 + 提詞浮層/藥丸/貼鏡。**不含 a11y**(aria、螢幕閱讀器、焦點、
計時)—— 這是刻意的取捨,不是遺漏;相關問題列在 P2 附錄。

---

## P0

### P0-1 總覽頁有兩張「三步」卡片,而且互相矛盾

**症狀**
新使用者第一次打開總覽頁,在「歡迎回來」下面會依序看到:
1. PreflightCard(compact)
2. 「3 分鐘上手」卡片:麥克風可用 / AI 模型可用 / 第一段提詞 `3 分鐘上手 0 / 3 完成`
3. 三大模式卡
4. 「開始三部曲」卡片:建立第一份講稿 / 個人化校準(語速+視距) / 跑一場錄音轉錄

兩張卡都是**三欄按鈕格 + 進度語意**,卻定義了不同的「三步」。使用者一開場看到
六個任務、兩套說法,而且無法判斷哪一套才是真的。

**證據**
- [Dashboard.tsx:244](../src/renderer/src/pages/Dashboard.tsx#L244) 開始三部曲區塊(標題在 259 行)
- [FirstRunSteps.tsx:105](../src/renderer/src/components/FirstRunSteps.tsx#L105) 3 分鐘上手卡片
- 同名:FirstRunSteps 的 aria-label 自稱「開始三部曲,已完成 N / 3 步」
  ([FirstRunSteps.tsx:109](../src/renderer/src/components/FirstRunSteps.tsx#L109)),
  而下方那張卡的字面標題就叫「開始三部曲」
- 完成態行為不一致:FirstRunSteps 刻意讓已完成的步驟**不可點**(見該檔檔頭,
  理由是「一個不渲染的按鈕比一個看得見但沒反應的按鈕誠實」);Dashboard 那張的
  done 項仍然是 `onClick={() => onNavigate(s.target)}`,只把 cursor 改成 `default`
  —— 看起來不能按、按下去卻會跳頁

**為什麼稽核量不到**
`domAudit` 驗的是每個元素的矩形、對比、命中區、是否被覆蓋。兩張卡在 DOM 上都是
合法的 button 與合法的文字;「它們在講同一件事」不是任何幾何性質。audit-states
的 `keyboard/*` 甚至會看到兩張卡各自貢獻了合格的停靠點。

**修法**
收斂成一張。保留 FirstRunSteps:它已經接上 preflight(不重複實作判斷)、完成後
自動收合成一行、done 規則正確。移除 Dashboard 的「開始三部曲」區塊,並把它真正
有價值的一步「個人化校準」併回 FirstRunSteps 的第一步(校準正是為了讓字級/速度
配對你的眼距與語速,屬於「麥克風可用」之前的準備動作,不是獨立的第三步)。

**驗收**
`[data-onboarding]` 在總覽頁恆為 ≤ 1 個(audit-states 新規則);`onboarding.test.ts`
更新後仍釘住「三步、每步都有具體動作」。

---

### P0-2 第一次打開看不到旗艦功能

**症狀**
沒有講稿時,總覽頁只寫一句「還沒有講稿——到『提詞講稿』頁建立第一份吧」,而
空稿刻意不開浮層(見 `launchScript`)。於是「提詞浮層」——這個產品的門面——在
使用者自己寫出一份有內容的講稿之前,完全看不到。

這與本專案自己的設計理念直接衝突:`preflight.ts` / `onboarding.ts` 的檔頭都寫著
「擋路的精靈會讓只想看看浮層長什麼樣的人永遠進不去」。而不擋路的代價是:他
**還是**看不到 —— 只是變成了自己的錯。

**證據**
- [Dashboard.tsx:233](../src/renderer/src/pages/Dashboard.tsx#L233) 空狀態文案
- 全 repo 唯一一鍵載入示範稿的入口在除錯面板:
  [DebugPanel.tsx:610](../src/renderer/src/components/DebugPanel.tsx#L610)「載入範例稿」
- 稽核自己的筆記:`docs/audit/journey/report.json` → notes
  `"無講稿時顯示浮層的按鈕": "（無）"`

**為什麼稽核量不到**
audit-journey 問的是「這條路走不走得**到**」。在沒有講稿的狀態下沒有開浮層的
按鈕,對它來說是「這一步沒有控制項」而不是「使用者應該到得了」。它把觀察寫進
notes 就結束了 —— 這正是「量到的東西 ≠ 該修的東西」的典型。

**修法**
內建一份範例講稿(沿用 `scripts/capture-ui.mjs` 與 DebugPanel 那份同一內容),
在講稿頁空狀態與總覽頁空狀態各放一顆「載入範例講稿並試提詞」:一鍵建立 →
儲存 → 直接開浮層。使用者 30 秒內看到旗艦功能,而且看到的是「一份寫好的稿
跑在浮層上」,不是空浮層。

**驗收**
audit-journey 新增一步:空狀態 → 按下這顆鈕 → 浮層視窗存在且**帶到內容**
(不是只有視窗)。

---

### P0-3 浮層時間列顯示 `0:00 / -0:00`

**症狀**
浮層工具列最左邊的時間顯示是 `已播 / -剩餘` 的寫法。講稿播完(或稿子沒有內容)
時,使用者看到的是 **`0:00 / -0:00`** —— 一個負的零。

**證據**
- [OverlayApp.tsx:1032](../src/renderer/src/overlay/OverlayApp.tsx#L1032):
  `` {remainingMs !== null && ` / -${formatDuration(remainingMs / 1000)}`} ``
- [utils.ts:5](../src/renderer/src/lib/utils.ts#L5) `formatDuration` 用
  `Math.max(0, Math.floor(sec))` clamp,所以剩餘 0 秒顯示 `0:00`,前面的手寫
  負號讓它變成 `-0:00`
- 實際畫面:audit-journey 的 notes 記下了這一幕 ——
  `"浮層文字前 80 字": "\"未命名講稿 0:00 / -0:00 ↺ 60 A- A+ 這是驗證用講稿內容。..."`
  (稽核照到了,但沒有任何規則會對一句合法的字串判紅)

**為什麼稽核量不到**
`truncated-no-label` 看的是有沒有被截斷、`tiny-text` 看的是字級、
`animation-unsettled` 看的是動畫是否收斂。沒有任何一條規則比對**語意**:負零是
一個完全合法的字串。

**修法**
兩件事一起修:
1. **語意**:`0:00 / -1:48` 沒有告訴任何人哪個數字是哪個(只有 `title="已播時間"`
   給第一個數字)。改成明講的 `已播 0:00 · 剩 1:48`。
2. **荒謬值**:剩餘為 0 時顯示 `已播畢` 而不是 `剩 0:00`;`formatDuration` 不該
   有機會收到負值(呼叫端不得自己畫負號)。

**驗收**
新增單元測試釘住「剩餘 0 / 負值 都不會產生帶負號的時間字串」,以及
`formatDuration(-1) === '0:00'`;浮層截圖人眼確認。

---

## P1

### P1-1 藥丸的狀態點只靠顏色,而穿透狀態下 tooltip 根本觸發不了

**症狀**
藥丸的狀態用一顆 8px 圓點表達(這是刻意的:見 global.css 對光暈的說明)。
但四種狀態是:
- 滑鼠穿透中:`bg-amber-450`
- 已播畢:`bg-amber-450/80`
- 播放中:`bg-emerald-400`
- 待機:`bg-white/25`

「穿透」與「已播畢」只差 20% 不透明度。而最糟的是:**點擊穿透狀態下,視窗根本
收不到游標事件**,所以那顆點上唯一的說明(`title="滑鼠穿透中…"`)在此狀態下
永遠不可能顯示。使用者看到一顆琥珀色的點,而它不會回應任何點擊。

**證據**
- [OverlayApp.tsx:714](../src/renderer/src/overlay/OverlayApp.tsx#L714) `data-pill-dot`
- 同處的 `title` 分支
- 藥丸只有 42–48px 高、單行 162px 寬,所以狀態文字必須很短才放得下

**為什麼稽核量不到**
對比度檢查逐元素算顏色比值 —— 兩顆 8px 的琥珀點各自都合格。要看出「這兩個是
不同狀態」需要跨元素比較語意,而 domAudit 不做這件事。

**修法**
狀態改用**形狀**區分,顏色只當輔助:
- 待機:空心圓
- 播放中:實心圓(綠)
- 已播畢:方形/雙豎線(琥珀)
- 滑鼠穿透:滑鼠圖示(琥珀),並在藥丸寬度允許時直接顯示「穿透中」三個字
並且新增 `data-overlay-state`(狀態名)作為稽核錨點。

**驗收**
audit-deep 新增規則:藥丸狀態元素必須帶非空的 `data-overlay-state`,且狀態屬於
`clickThrough` / `completed` 時必須有非顏色以外的區分(形狀或文字)。

---

### P1-2 浮層展開面板 20+ 個 icon-only 控制項,只有原生 tooltip,而且沒有分組

**症狀**
展開面板的工具列是一條可橫向捲動的長條,塞了 20 顆左右的純圖示按鈕,分成:
即時教練類、救援、置中、收合、貼鏡、跟讀、播放/上一個下一個、速度、字級、
鏡像、螢幕擷取隱形、滑鼠穿透、關閉。全部只有 `title`,而:
- 原生 tooltip 要 hover 約 1 秒才出現,而使用者的手正在簡報
- 工具列本身可橫向捲動 —— 捲動位置的內容在 tooltip 出現前會先跑掉
- `title` 的內容是句子(例如貼鏡模式那條 40 字的說明),不是標籤

**證據**
- [Surfaces.tsx:19](../src/renderer/src/overlay/Surfaces.tsx#L19) `ToolBtn` 只吃 `title`
- `grep -c "title=" OverlayApp.tsx` = **41**,是全站最密的一個檔案
- 對照:模式選擇器用 `Segmented`,它至少有 `aria-label` 群組名稱
  ([OverlayApp.tsx:1008](../src/renderer/src/overlay/OverlayApp.tsx#L1008))

**為什麼稽核量不到**
`no-accessible-name` 把 `title` 當成合格的名稱來源(這是刻意的:沒有名稱的
icon-only 按鈕才是缺陷)。所以「只有 tooltip 的揭露」在稽核眼裡是**加分項**。

**修法**
1. 工具列分成三組並加上可見的分隔(播放/前進;顯示與字級;救援與視窗),
   讓「20 顆按鈕」變成「3 組各 4–8 顆」
2. 說明列:游標/鍵盤焦點落在哪一顆,浮層底欄就報那一顆的**一眼可讀短標籤**
   (播放、貼鏡、穿透…),長說明當第二行(底欄是既有的一列,不被裁切、不佔寬度)
3. **原生 `title` 留著**,不取代(原計畫寫的是「取代」,實作時推翻了):
   - 六支稽核與大量 e2e 定位器以 `title` 找浮層控制項 —— 拿掉會讓它們回報
     「找不到控制項」(那是工具壞了,不是 UI 壞了)
   - 貼鏡形態的視窗只有 170px 高、沒有說明列,`title` 是那裡唯一的長說明

   ⚠️ 也不可以「順手」再加 `aria-label={title}`:效果稽核的列舉端只對 `title`
   做收斂(括號/冒號處切斷),`aria-label` 一旦並存,身分會從「暫停」變成
   「暫停(空白鍵)」,20 幾筆登記當場對不上(實測:probe-not-found +
   no-effect-probe 各一片)。理由寫在 [Surfaces.tsx:19](../src/renderer/src/overlay/Surfaces.tsx#L19)。

**驗收**
audit-deep 新增規則:浮層工具列的每個 icon-only 控制項,其可見標籤覆蓋率
(自製 tooltip 的 `data-tooltip-label`)必須是 100%;先以 advisory 執行,修完
之後才納入封鎖。

---

### P1-3 設定頁 10 個區塊、1048 行、單一長捲動、沒有目錄

**症狀**
設定頁把 10 個區塊(個人化校準、提詞浮層、語音辨識、開始之前、AI 助理、快速鍵、
你的資料去了哪裡、資料備份、疑難排解…)垂直疊成一個長捲動頁。要找「快速鍵」
必須一路捲過五個區塊。Section 沒有 `id`,所以外部也無法錨定到某一段
(例如錯誤 toast 想說「去設定頁的語音辨識」時,只能叫人自己找)。

**證據**
- [SettingsPage.tsx:51](../src/renderer/src/pages/SettingsPage.tsx#L51) `Section`
  —— 只吃 title/desc/children,沒有 id
- 區塊清單:`grep -n "<Section" src/renderer/src/pages/SettingsPage.tsx`

**為什麼稽核量不到**
audit-ui 逐頁截圖 + domAudit 逐元素檢查。一頁 10 個區塊、每個區塊都合格,就是
「合格」。頁面層級的導航/可尋性不是任何單一元素的性質。

**修法**
`Section` 接受 `id` 並輸出 `id` + `scroll-mt`;頁首加一條 sticky 的區塊目錄
(chip 列),點擊捲到該區塊;目錄同時提供穩定的 `data-settings-toc` 錨點。

**驗收**
audit-states 新增規則:設定頁每個 `[data-settings-section]` 的 id 都出現在
目錄連結集合中(雙向相等)。

---

### P1-4 「載入中」的 disabled 欄位沒有任何說明

**症狀**
API Key 欄位在 `secureKeysLoaded` 為 false 時是 disabled。正常情況這個窗口只有
幾毫秒,但金鑰讀取失敗或 IPC 卡住時,欄位會**永遠灰著**,而畫面上沒有任何一句話
說明為什麼、要怎麼辦。使用者能做的最合理推論是「這個功能壞了」。

**證據**
- [SettingsPage.tsx:653](../src/renderer/src/pages/SettingsPage.tsx#L653)(STT 金鑰)
- [SettingsPage.tsx:781](../src/renderer/src/pages/SettingsPage.tsx#L781)(AI 金鑰)
- 兩處的 label 都只有「API Key」,沒有任何狀態文字

**為什麼稽核量不到**
`disabled` 的元素仍然有正確的命中區(不,它反而更不會被報)、仍然有 `aria-label`。
domAudit 沒有任何規則在問「這個控制項為什麼不能按」。

**修法**
在欄位下方加一行狀態文字:`金鑰載入中…` → 載入完成後消失;讀取失敗時顯示
「讀不到已儲存的金鑰(可重新輸入覆蓋)」並可繼續使用(而不是永遠 disabled)。
把「永遠 disabled」換成「讀不到就當作沒有舊金鑰」—— 後者至少讓功能可用。

**驗收**
人眼 + audit-states 的 `keyboard/settings` 停靠點數量不變;新增測試釘住
「讀取失敗時欄位回到可用」。

---

## P2 附錄(本輪**不**修,只記錄)

| # | 問題 | 為什麼先不做 |
|---|---|---|
| 1 | 錄音中沒有環境指示 ✅ **縮小版已修(2026-10-03)**:視窗標題「● 錄音中」+ 工作列閃爍(`lib/captureIndicator.ts` + `IPC.WindowCaptureIndicator`),會議錄音/講稿錄影/練習作答三處接線,離頁必還原 | tray 圖示版(需要平台資源與分支,Mac 的 .icns/.png)仍是獨立一輪 —— 見 CHANGELOG「使用者邏輯掃描」第 6 條 |
| 2 | 全站 66 處 `text-[10px]`、74 處 `text-[11px]`,而稽核下限 `MIN_FONT_PX` 正好是 10 | 門檻就在用例的正上方,所以永遠量不到。要提高門檻必須先縮減這些地方 —— 那是設計決定,不是修 bug |
| 3 | 手寫 chip 群組(供應商/場景情境/題數)選取態只靠顏色,與 `Segmented` 的語彙不統一 | 屬 a11y 範疇(非色彩提示),本輪不碰 |
| 4 | 「場景情境」的 tone / risk / source 只存在於 `title`(要選一個場景的人看不到它的風險等級) | 同上,與 P1-2 的 tooltip 工程一起做更划算 |
| 5 | 主視窗沒有任何鍵盤加速(Ctrl+S 儲存、Ctrl+F 找講稿、清單↑↓) | 與 a11y 沾邊,本輪不碰 |

---

## 稽核補強(這一輪的第三個交付物)

修完之後,把上面每一條「量不到」的類別補成規則。原則與 repo 既有慣例一致:
**先修、後開門檻**,新規則必須在修好的狀態下綠燈才算數;寧可漏報也不要誤報。

| 規則 | 放在哪 | 錨點 |
|---|---|---|
| 總覽頁最多一張 onboarding 卡 | audit-states | `[data-onboarding]` 數量 ≤ 1 |
| 每個 onboarding 步驟都有具體動作 | 既有 `onboarding.test.ts` | 純函式 |
| 空狀態 → 範例稿 → 浮層開啟且帶到內容 | audit-journey(新步驟) | 端到端 |
| 設定頁每個區塊都出現在目錄中 | audit-states | `[data-settings-section]` id ↔ 目錄連結 |
| 藥丸狀態必須有非顏色的區分(預設 vs 穿透的形狀簽章不得相同) | audit-deep | `[data-pill-dot]` + `data-overlay-state` + 穿透必須有文字 |
| 時間列不得產生負號時間(含剩餘 0) | 單元測試 | 純函式 |
| 浮層工具列每一顆按鈕都有短標籤 | audit-deep | `[data-toolbar-shell]` 下的按鈕都帶 `data-tooltip-short` |
| 範例稿鈕真的建稿 + 開浮層(總覽 / 講稿各一) | audit-effects | `data-effect-id="demo-script"`(兩筆登記) |
| 校準提醒那一行真的導到校準頁 | audit-effects | `data-effect-id="onboarding-calibration"`(scope=onboarding) |
| 目錄的區塊鈕真的捲動頁面 | audit-effects | `settings\|id:settings-toc`(九顆共用一筆登記) |

上表在實作後全數綠燈;兩條新版 audit-deep 規則另外做過負向驗證(拿掉「穿透」
文字與一顆短標籤 → 當場 `pill-state-no-text` + `overlay-toolbar-unlabelled`,
還原後回 44 個狀態 / 0 筆問題)。
