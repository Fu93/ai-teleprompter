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

---
---

# 第二輪:同一支稽核,換一個起點(2026-10-03)

第一輪的起點是「六支稽核同時回報 0 problems」,於是去讀 UI 找它們量不到的
類別。第二輪的起點換了一個,更難反駁:

> **`grep -rn "錄影" e2e/` 的結果是零。**

這個 App 最資料密集的功能(攝影機 + 麥克風 + 磁碟寫入,一個小時幾百 MB)
**沒有任何一條端到端測試**。而它在第一輪的稽核眼裡是綠的:每個控制項都有
按下去,按下去之後畫面真的變了(計時器開始跑)。

兩件事同時成立,這就是第二輪要處理的東西。格式沿用第一輪:**症狀 → 證據 →
為什麼量不到 → 修法 → 驗收**。這一份的第二、三欄一樣是這份文件存在的理由。

這一輪的問題清單是九條(P0 一條、P1 四條、P2 四條只記錄)。

---

## P0

### P0-A 錄影提詞在關窗的那一刻,整段錄影靜默消失

**症狀**

使用者在講稿頁按下「錄影提詞」,對著鏡頭講了 40 分鐘。他按 X 關掉視窗 ——
沒有確認框、沒有「要存檔嗎」、沒有任何提示。錄影就這樣沒了,磁碟上什麼都沒有。
而在 40 分鐘裡,只要他按到別的視窗重疊、鎖一次螢幕、或只是點了應用程式視窗的
最小化以外的任何操作,那段錄影的命運都不受任何保護。

**證據**

- 這一輪之前,[Scripts.tsx](src/renderer/src/pages/Scripts.tsx) 只有一個
  `useCloseGuard('scripts-dirty', ...)`(講稿有未存變更),**錄影完全不在任何守衛裡**
- 沒有 `onGuardChange`,所以 `App.tsx` 的離頁確認框不知道錄影正在進行 ——
  錄影中點側欄任何一項,`unmount` 直接 `recorder.stop()`,然後使用者被丟一個
  存檔對話框(他只是想看一下別的頁)
- 沒有 `powerSaveStart`:筆電睡眠時錄影會停,而畫面上的計時器跟著凍結 ——
  使用者醒來只看到一個「停在某個時間」的介面,不知道發生了什麼
- `state.isRecording` 是**錄音用的旗標**,講稿錄影完全不碰它,所以 main 端的
  `quitGuard` 也不管錄影
- 存檔走的是舊路徑 `IPC.SaveRecording`
  ([ipc.ts:421](src/main/ipc.ts#L421)):整段 bytes 一次過 IPC,取消 = 全部丟棄,
  而 bytes 從頭到尾只存在 renderer 記憶體裡的 `recChunksRef`

**為什麼稽核量不到**

1. **audit-effects 量得到「按了有效果」**:按下錄影 → 計時器開始跑 → 有效果。
   它問的是「按下去之後有沒有變化」,不是「關窗之後會不會沒」。
2. **audit-states 量不到守衛**:它的對話框探針準備的觸發條件是「講稿有未存變更」,
   而錄影中沒有任何狀態會讓它去按 X。
3. **domAudit 不量「資料會不會不見」**:它是幾何/對比/命中區的檢查器。
4. **e2e 沒有這條路的測試**:`grep 錄影 e2e/` 零命中,最資料密集的功能零覆蓋。

這一條同時是「量不到」和「量錯」:audit-effects 給它蓋了一個綠章,而那個綠章
的量測單位(「有變化」)根本不涵蓋它真正的失效(「會消失」)。

**修法**

1. **分片落盤**:新增 [videoRecording.ts](src/main/videoRecording.ts)。
   `beginVideoRecording` 開暫存檔,`appendVideoChunk` 每個 chunk 立刻寫進去,
   `finishVideoRecording` 關檔。所以「錄了 40 分鐘」在記憶體裡只有最後一個 chunk,
   它的內容**任何時刻都已經在磁碟上**。
2. **三道守衛**(與錄音頁同一個標準):`useCloseGuard('scripts-recording')`、
   側欄離頁守衛(`onGuardChange`)、`powerSaveStart`。
3. **退出前 flush**:`window.__aiTpFlushRecording` 讓 main 的 `quitGuard` 收得到
   完整的檔案。它**不彈存檔對話框** —— OS 關機時沒有人能回答它,那會把退出卡住
   (而卡住正是 quitGuard 存在的理由)。檔案下一次啟動被 `listOrphanRecordings()`
   撿回來,由使用者決定留不留。
4. **`state.isRecording` 真的被設起**:Begin 設 true,**只有 Save / Abort 才放下**
   —— 存檔對話框開著的那段時間仍然是「錄影中」,仍然受 quitGuard 保護。
5. **存檔失敗不再等於丟棄**:取消存檔時 main 問
   「存到預設資料夾 / 放棄這段錄影」,而不是把整段丟掉。
6. **孤兒檔橫幅**:下次啟動時 `listOrphanRecordings()` 列出上次沒結案的檔案,
   兩顆鈕決定留或丟。**沒有存檔對話框被打斷的那條路,資料也不會不見。**

**驗收**

- [e2e/video-recording.spec.ts](e2e/video-recording.spec.ts)(blocking,**四條**):
  關窗被守衛擋下 / 側欄離頁被守衛擋下 / 睡眠阻擋被設起並可解除 /
  退出前 flush 的掛鉤存在且真的能收尾。
- **負向驗證**:三道守衛(`scripts-recording` / `onGuardChange` / `powerSaveStart`)
  **同時**拿掉之後,三條 e2e 各自紅在自己的斷言上(關窗那條紅在「找不到
  對話框」、離頁那條紅在「取消鈕不存在」、睡眠那條紅在 `Received: 0`)。
  如實記下一件我**沒有**證明的事:沒有單獨拿掉任何一道守衛各跑一次,
  所以「每一道各自都能擋下」是從「三道一起拿掉三條都紅」推出來的。
- 退出前 flush 那條**原本是缺口**(沒有任何測試會在掛鉤被拿掉時變紅;
  main 端的呼叫點對「掛鉤不存在」是靜默放行),後來補上了:第四條 e2e 斷言
  掛鉤必須存在,實測拿掉 `Scripts.tsx` 的掛鉤 effect → 紅在那一行,還原後回綠。
  補的過程還抓到一個真缺陷:掛鉤與 `onstop` **各自 finish 一次**,第二發落在
  「沒有進行中的錄影」回 false —— quitGuard 會把一場其實存好的錄影記成
  「退出前存檔失敗」。修成單一 finish 點(onstop 排空佇列後關檔,掛鉤等它、
  憑它回報;5 秒後備防裝置消失)。
- 存檔路徑的七個 IPC 都有 `EVIDENCE` 對應的效果分類,預覽走
  `app://rec/<name>`(新的 host,[appProtocol.ts](src/main/appProtocol.ts) 只服務
  temp / videos 兩個根目錄 + `.webm/.mp4`)。

---

## P1

### P1-B 停止錄影 = 立刻要求存檔,「取消」= 整段丟棄

**症狀**

按「停止錄影」→ 存檔對話框 → 使用者猶豫了,按了取消。他想的其實是「先存到預設
位置就好」。得到的結果是:錄影停止、畫面上的計時器歸零、磁碟上什麼都沒有 ——
而且他剛剛才講完,不可能再錄一次。

**證據**

- 舊路徑 `IPC.SaveRecording`:`canceled` 直接 `return { ok:false, error:'canceled' }`,
  而唯一的資料來源是 `recChunksRef`(記憶體)
- 從頭到尾沒有「存到預設資料夾」這個選項,所以「取消」在 UI 的心智模型裡
  是合理的 —— 這一條的根因不是使用者誤操作,是**選項不夠**

**為什麼量不到**

`preview|button|關閉錄影預覽` 有探針、`rec-start` 有探針,可是
「取消存檔之後資料還在嗎」沒有任何一條規則問。它不是任何控制項的**效果**,
它是某一條路徑**沒有被走出來**時的後果。

**修法**

`saveVideoRecording()` 在取消時改問
「存到預設資料夾(`影片/AI 提詞機`)/ 放棄這段錄影」,預設選項是前者。
資料此刻已經在暫存檔上,所以這個提問的成本從「丟掉幾百 MB」變成「多按一次」。

**驗收**

存檔回傳 `autoSaved`(存到預設資料夾)/ `discarded`(真的放棄)/ `previewName` +
`previewable`。e2e 與 audit-effects 都不允許出現「cancel 之後資料沒了又沒有
第二個選項」的世界。

### P1-C 「更新已下載」只住在設定頁,而且是一次性的

**症狀**

electron-updater 在啟動 30 秒後下載完更新,廣播 `update-downloaded`。使用者
通常在總覽頁,那裡沒有任何訂閱者 —— 事件被丟掉。他之後進設定頁看到的仍是空白,
而 `autoInstallOnAppQuit` 會在他下次關閉 App 時**默默裝掉它**。

更糟的一個世界:主視窗可能根本不在(浮層模式下關掉主視窗是正常用法),
`state.mainWindow` 是 null,廣播沒有收件人。

**證據**

- 原本訂閱在 `SettingsPage` 的 mount effect 裡(一次性)
- `updater.ts` 只廣播給 `state.mainWindow`(單一收件人),不是
  `BrowserWindow.getAllWindows()`
- `AppInfo` 沒有任何「目前有沒有待安裝更新」的欄位

**為什麼量不到**

audit-effects 量得到「按下重啟鈕會怎樣」—— 那顆鈕在設定頁,而稽核環境永遠不會
真的下載一個更新,於是那顆鈕**從來沒有被列舉過**,於是它不在登記表裡,也沒有人
知道它是一個只存在五秒鐘的提示。

「事件會不會被錯過」不是任何一條規則的對象:它是一個**時間**問題。

**修法**

新增 [lib/update.ts](src/renderer/src/lib/update.ts),狀態放在 App 層(橫幅長在
`MainApp` 最上層,六個頁面共用),兩條路都要走:

1. `watchUpdate()` 訂閱即時事件
2. `hydrateUpdate()` 掛載時回 `appInfo().updateInfo` 補問 —— **這是這支模組存在
   的主要理由**:沒有它,「錯過了」與「沒有更新」不可分辨

main 端把 `state.updateInfo` 存下來(補問的來源),廣播改成
`BrowserWindow.getAllWindows()`。

**驗收**

`__tests__/update.test.ts` 四條:補問真的補回來 / 補問失敗不丟掉既有狀態 /
沒有更新時不憑空生一則 / 同版重按「稍後」不重置、換版才重置。

⚠️ **這一組測不到接線,而且我實測確認了這一點**:把 App.tsx 裡的
`void hydrateUpdate()` 拿掉之後,這四條**全綠**(實測)。因為它們測的是 store
函式本身,不是「誰在 mount 時呼叫它」。這正是這個 repo 自己的結論
(「元件內接線,單元測試測不到」)——寫下來是為了不要讓讀的人以為這四條
擋住了整條路徑。

真正被量到的是另一件事:橫幅整個不渲染時,效果稽核會紅三條
(`state-unreached` ×2 + `probe-not-found`,實測拿掉 `<UpdateBanner />` 後)。

### P1-D 熱鍵註冊失敗的警示只住在設定頁,而側欄無條件承諾

**症狀**

在一台 `Ctrl+Alt+T` 被別的程式占走的電腦上,側欄每一頁都白紙黑字寫著
「Ctrl+Alt+T 顯示 / 隱藏浮層」。他按下去,什麼都不發生。他要繞到設定頁才會
看到那條「註冊失敗」—— 而一個「按了沒反應」的人不見得會繞。

**證據**

- 這一輪之前,`hotkeyConflicts` 只在 `SettingsPage` 用本地 state 讀
- `App.tsx` 的 `SidebarHotkeyHint` **只讀設定值、不讀衝突**
- [Dashboard.tsx:295](src/renderer/src/pages/Dashboard.tsx#L295) 的 footer
  同樣無條件把組合寫給使用者

**為什麼量不到**

那條警示本來就長在設定頁,所以「設定頁有警示」是成立的、也是綠的。沒有任何規則
比對「還有哪些畫面在無條件承諾同一組熱鍵」—— 那是一個**跨元件的語意**問題。

而且這條規則在乾淨的機器上永遠量不到:`appInfo().hotkeyConflicts` 恆為空陣列。
一條永遠不會變紅的規則等於沒有規則。

**修法**

新增 [lib/hotkeys.ts](src/renderer/src/lib/hotkeys.ts) 作為單一出處,三個使用端
(設定頁 / 側欄 / 總覽頁)共用:

- 側欄那一行在衝突時**否認功能**(`註冊失敗 —— 按了沒反應`)而不是照舊承諾
- 總覽頁 footer 出現「N 顆熱鍵註冊失敗」
- 側欄多一顆鈕通往設定頁(`data-effect-id="hotkey-conflict"`)
- 稽核橋 `app.hotkeyConflicts`:讓「沒衝突的機器」也量得到「有衝突時會不會告知」

**驗收**

`audit-states` 新一相 `A7`:製造衝突 → 三個承諾點都要有告知 → 衝突鈕真的導到
設定頁 → 清空覆寫後警示必須消失(過期警告比沒有警告更糟)。

負向驗證做了三種拆法(實測都紅,而且紅在不同的那一行):
- 拿掉衝突鈕 → `側欄沒有「到設定頁修改」的出口(有告知但到不了)`
- 只掛 `data-hotkey-conflict` 屬性、文字照舊寫「顯示 / 隱藏浮層」
  → `側欄的警示文字沒有否認功能`
- 連屬性都拿掉(就是本輪改動前的原狀)→ `側欄仍然在無條件承諾熱鍵功能`

### P1-E 浮層工具列宣稱「空白鍵」,但那個鍵在真實情境下按不到

**症狀**

展開面板的播放/暫停鈕寫著「暫停(空白鍵)」,上一個/下一個重點寫著「← / →」。
但浮層是用 `showInactive()` 顯示的 —— **刻意不搶焦點**,否則會打斷使用者正在
簡報的那個應用程式。而空白鍵只在**浮層自己有焦點**時才送得到那裡。

於是那三個括號裡的捷徑在真實使用情境下多半不成立。而永遠成立的那一顆
(全域 `playPause`,預設 `Alt+K`)從未在工具列上出現過。

**證據**

- [OverlayApp.tsx:1273](src/renderer/src/overlay/OverlayApp.tsx#L1273)(改動前
  是 `暫停(空白鍵)`)
- `windows.ts` 用 `showInactive()`
- 對照:側欄熱鍵提示本來就讀設定值,工具列卻寫死

**為什麼量不到**

`no-accessible-name` 把 `title` 當成合格的名稱來源(這是刻意的)。而括號裡的
內容是**事實錯誤**,不是幾何問題、不是對比、不是命中區。沒有任何一條規則比對
「這顆按鈕宣稱的捷徑,是不是真的隨時按得到」。

**修法**

改成指名真正全域的那一顆,並把本地鍵降級成明確標註前提的次要資訊:

- `播放(Alt+K;浮層有焦點時可用空白鍵)`
- `下一個重點(Alt+Up;浮層有焦點時可用 →)`

`title` 的身分靠 `normalizeTitle` 在 `(` / `（` / `:` 處切斷維持,所以捷徑放進
括號裡**不會**改變效果稽核的身分(實測:49 個浮層控制項、0 個新問題)。

**驗收**

`audit-deep` 新規則 `overlay/expanded@toolbar-key-hints`,三個方向都要驗:

1. 提到本地鍵的 title 必須同時指名全域鍵(`overlay-local-key-without-global`)
2. title 裡的每個和弦都必須是設定裡真的熱鍵,不是寫死的預設值
   (`overlay-stale-hotkey-label`)
3. 播放/暫停必須指名 `playPause`

三個方向缺一不可:只驗 1,「把本地鍵刪掉」會通過;只驗 3,其他顆可以寫死。

---

## P2 附錄(第二輪只記錄,不修)

| # | 問題 | 為什麼先不做 |
|---|---|---|
| 1 | 總覽頁與講稿頁各有一張卡同名「提詞浮層」(第一輪的 P1-2 已用 `data-effect-scope` 解決計數,但命名本身仍重複) | 屬命名/文案決策,不是規則能量到的;合併要動 onboarding 的內容 |
| 2 | `lastUsedAt` 被寫進四個地方,**從來沒有被讀過** | 刪掉它會讓「最近使用」之類的功能失去基礎,但要先決定那個功能存不存在;順手刪會讓資料模型看起來更乾淨卻少了一個欄位 |
| 3 | 關掉主視窗 10 秒後 App 靜默退出,使用者沒有任何告知 | quitGuard 的逾時是刻意的(OS 關機時沒有人能回答對話框),但「使用者自己按 X」與「OS 關機」走同一條路;要分開得讓 renderer 知道是誰發起的 |
| 4 | 講稿列的「最後使用」不顯示(所以第一條的 `lastUsedAt` 對使用者完全不可見) | 同上第 2 條,是一組決策 |

---

## 第二輪的稽核補強

| 規則 | 放在哪 | 錨點 | 抓的是哪一條 |
|---|---|---|---|
| 錄影中:關窗 / 切頁被守衛擋下,睡眠阻擋被設起 | e2e(blocking) | `rec-stop` / `rec-countdown-off` / powerSave blocker | P0-A |
| 熱鍵衝突時三個承諾點都要告知 + 衝突鈕導得到 + 收回 | audit-states `A7` | `data-hotkey-conflict` / `app.hotkeyConflicts` | P1-D |
| 工具列的本地鍵必須伴隨真正全域的鍵;和弦不得寫死 | audit-deep | `[data-toolbar-shell]` + `hotkeys` | P1-E |
| 更新橫幅的兩顆鈕要登記(否則新增會靜默不被列舉) | audit-effects | `data-effect-scope="update"` | P1-C |
| 熱鍵衝突鈕要登記 | audit-effects | `idKey('hotkeys','hotkey-conflict')`(豁免:需真衝突) | P1-D |

**先修、後開門檻**:每一條新規則都做過負向驗證 —— 拿掉對應的程式碼之後,
該支稽核要**紅在對的那一行**。這是這個專案被教訓過一次的地方:
刪掉一筆登記本來就該變紅,而盯著三次全綠就以為收斂了。
