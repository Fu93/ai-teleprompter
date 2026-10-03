/**
 * effect-inventory.mjs — 「所有 UI/UX 都有效果」的清單與覆蓋率規則。
 *
 * ── 這一支存在的理由 ──
 *   audit-effects 原本問對了一個問題(「按下去,系統裡真的變了東西嗎」),
 *   但它只問了 11 個控制項。其餘約 150 顆控制項,四支 DOM 稽核全都量過 ——
 *   量的是**存在**(夠大、有名稱、沒被截斷),不是**效果**。
 *   於是「提詞機的錄音會不會動」「AI 摘要按下去有沒有東西」這種問題,
 *   在 84 個全綠的數字裡完全看不出來。
 *
 *   更大的問題是:**沒有任何機制會在新增一顆沒被驗過的按鈕時變紅。**
 *   所以覆蓋率只會靜默縮水 —— 而這個專案已經被假綠燈教訓過四次。
 *
 * ── 三方一致性(這是本檔的全部意義) ──
 *   1. 列舉(ENUMERATE,在頁面裡跑):DOM 上真的有這顆控制項嗎?
 *   2. 登記(CONTROLS,在這裡):它應該有效果探針,或有一個**附理由**的豁免。
 *   3. 執行(audit-effects 的探針):這一輪真的跑過它、真的觀察到狀態變化嗎?
 *
 *   三邊對不上的任一種都是問題:
 *     列舉有、登記沒有        → no-effect-probe(新增控制項沒人驗)
 *     登記有、列舉沒有        → probe-not-found(探針在對不存在的東西斷言)
 *     登記有、執行沒有        → probe-not-run(探針被條件跳過卻沒說)
 *   第三條最重要:它讓「這一輪沒跑到」不會長得像「這一輪沒問題」。
 *
 * ── 身分(controlKey)怎麼決定 ──
 *   預設 `${page}|${role}|${name}`,name 取使用者看得到的名字
 *   (textContent → aria-label → title → placeholder);
 *   `data-effect-id` 優先,用於**名字由資料決定或會變動**的控制項 ——
 *   例如會議卡片標題是使用者自己取的、錄影鈕的文字含計時器。
 *   沒有這個覆寫,那些控制項的 key 每一輪都不一樣,覆蓋率檢查會永遠是紅的
 *   —— 而一個永遠紅的檢查等於沒有檢查,這是本專案已經寫過一次的教訓。
 *
 *   重複的控制項(列表的每一列)以**基礎鍵**登記:去掉 `#n` 序號之後同名同角色
 *   就是同一種控制項的多個實例,一顆探針涵蓋整族。
 */

/** 效果的分類。unverifiable 必須附 category,才分得出「量不到」與「沒去量」。 */
export const EXEMPT_CATEGORY = {
  NATIVE_DIALOG: '系統原生對話框(headless 點不到)',
  MODEL_DOWNLOAD: '需要下載模型(數百 MB、依賴網路)',
  FACE_FIXTURE: '需要有人臉的影像 fixture(合成彩條圖沒有人臉)',
  DESTRUCTIVE_WINDOW: '會終止稽核視窗本身(重載 / 關閉 / 真的寫檔到使用者資料夾)',
  REAL_DESKTOP: '需要可擷取的實體桌面與視窗',
  BROWSER_ENGINE: '由作業系統提供的功能(語音合成 / 剪貼簿),不是本 App 的邏輯',
  /**
   * 同一個控制項的另一個渲染狀態(例如「儲存」/「已儲存」是同顆鈕的
   * enabled/disabled 兩種外觀)。
   *
   * 這個類別是**必須的**,因為列舉是以「當下的 DOM」為準:一顆開關的兩面
   * 會產生兩個 key,而它們共用同一條行為。不把它們標成「同一顆」,
   * 覆蓋率就會逼你為同一個按鈕的每一個外觀各寫一條探針 —— 那種要求最後
   * 只會得到一堆互相重複、且沒人在看的假探針。
   */
  SAME_CONTROL: '同一個控制項的另一個狀態(與已驗的那一條共用行為)'
}

/**
 * 證據來源。**這是這個檔案最重要的一欄。**
 *   data-layer    : 從 window.api / IndexedDB 讀回(系統真的接受了)
 *   other-window  : 從浮層或另一個視窗讀(內容真的送到使用者眼前)
 *   geometry      : 可讀的幾何量(scrollTop 前進、捲動距離)
 *   dom-container : 被點元素**以外**的 DOM 元素真的變了(modal 收掉、toast 移除、
 *                   明細展開)。與 self 的差別是「觀察的對象不是我自己」。
 *   self          : 只有被點的那顆元素自己在說它生效了(aria-checked / class)
 *                   → **不算有效果**,會被記成 self-evidence 問題。
 *                     `self` 只在「同時有另一個來源」時當補充,不能當唯一證據。
 */
export const EVIDENCE = {
  DATA: 'data-layer',
  OTHER_WINDOW: 'other-window',
  GEOMETRY: 'geometry',
  DOM: 'dom-container'
}

/** 基礎鍵:去掉重複序號。列舉端與登記端都經過這一手,才對得起來。 */
export function baseKey(k) {
  return String(k).replace(/#\d+$/, '')
}

/** 組 key 的小工具(名稱一律先正規化空白,與 ENUMERATE 的規則一致)。 */
export function key(page, role, name) {
  return `${page}|${role}|${String(name).replace(/\s+/g, ' ').trim()}`
}

export function idKey(page, id) {
  return `${page}|id:${id}`
}

/**
 * title 的收斂(Node 端)。
 *
 * **必須與 ENUMERATE 裡的 cutTitle 一模一樣。** 兩邊不一致的症狀是:
 * 對帳說某顆控制項有探針,而探針點到的是另一顆控制項 —— 實際發生過,
 * 而它被記成「按了關閉但浮層還在」,長得像產品缺陷。
 */
export function normalizeTitle(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim()
  const cut = raw.split(/[（(:：]/)[0].trim()
  return cut.length >= 2 ? cut : raw
}

/**
 * 要列舉的狀態。state id 是 `${page}/${variant}`。
 *
 * **「沒有宣告狀態」等於「沒量到」**:沒有被列舉的狀態裡的控制項,
 * 連「有沒有被驗過」都不會被問。所以這份清單本身就是涵蓋率的一部分。
 */
export const STATES = [
  { id: 'dashboard/empty', page: 'dashboard', nav: 'dashboard', seed: 'none' },
  { id: 'dashboard/with-data', page: 'dashboard', nav: 'dashboard', seed: 'all' },
  { id: 'dashboard/with-scripts', page: 'dashboard', nav: 'dashboard', seed: 'script' },
  { id: 'dashboard/preflight-issues', page: 'dashboard', nav: 'dashboard', seed: 'preflightIssues' },
  { id: 'scripts/empty', page: 'scripts', nav: 'scripts', seed: 'none' },
  { id: 'scripts/with-script', page: 'scripts', nav: 'scripts', seed: 'script' },
  // 選取一份講稿之後編輯器才會出現(工具列、標題欄、textarea 都在裡面)。
  { id: 'scripts/editing', page: 'scripts', nav: 'scripts', seed: 'editing' },
  /**
   * **編輯器裡有未存變更**。
   *
   * 為什麼需要這個狀態:儲存鈕的文案是 `dirty ? '儲存' : '已儲存'`。
   * 剛選取一份稿時它是乾淨的,所以列舉端只會看到「已儲存」——
   * 而登記表寫的是「儲存」。兩邊都說得通、卻永遠對不上,
   * 覆蓋率就會把一顆真實存在的控制項報成「有登記但從沒出現過」。
   * 那不是列舉錯了,是**狀態清單少了一格**。
   */
  { id: 'scripts/dirty', page: 'scripts', nav: 'scripts', seed: 'dirty' },
  { id: 'scripts/preview', page: 'scripts', nav: 'scripts', seed: 'preview' },
  { id: 'record/idle', page: 'record', nav: 'record', seed: 'none' },
  { id: 'record/with-sessions', page: 'record', nav: 'record', seed: 'sessions' },
  // 展開第 N 場之後才會出現的三顆鈕(AI 摘要 / 存成講稿 / 刪除這場會議紀錄),以及
  // 已經有摘要那一場的「重新摘要」—— 兩種都要有,它們是不同的控制項。
  { id: 'record/session-open', page: 'record', nav: 'record', seed: 'sessionOpen' },
  { id: 'record/session-summarized', page: 'record', nav: 'record', seed: 'sessionSummarized' },
  // 錄音進行中:主要鈕從「開始錄音」變成「停止並儲存」(用假麥克風走真實路徑)。
  { id: 'record/recording', page: 'record', nav: 'record', seed: 'recording' },
  { id: 'record/report', page: 'record', nav: 'record', seed: 'report' },
  { id: 'practice/setup', page: 'practice', nav: 'practice', seed: 'runs' },
  { id: 'practice/run', page: 'practice', nav: 'practice', seed: 'practiceRun' },
  { id: 'practice/answering', page: 'practice', nav: 'practice', seed: 'practiceAnswering' },
  { id: 'practice/answered', page: 'practice', nav: 'practice', seed: 'practiceAnswered' },
  // 最後一題答完:同一顆鈕的文字從「下一題」變成「查看總評」。
  { id: 'practice/last-answered', page: 'practice', nav: 'practice', seed: 'practiceLastAnswered' },
  { id: 'practice/done', page: 'practice', nav: 'practice', seed: 'practiceDone' },
  { id: 'calibration/step0', page: 'calibration', nav: 'calibration', seed: 'none' },
  { id: 'calibration/step1', page: 'calibration', nav: 'calibration', seed: 'calStep1' },
  { id: 'calibration/step2', page: 'calibration', nav: 'calibration', seed: 'calStep2' },
  { id: 'settings/default', page: 'settings', nav: 'settings', seed: 'none' },
  { id: 'settings/openai', page: 'settings', nav: 'settings', seed: 'openai' },
  /**
   * 雲端辨識的三個欄位只在 `settings.stt.engine === 'cloud'` 時才渲染。
   *
   * 前面的狀態為了驗「引擎切換」把它留在別的值上(而且那是**上一輪探針**
   * 留下的),所以這三顆欄位從未出現在任何宣告狀態裡。
   * 狀態清單是列舉端的依據 —— 它漏了,不是頁面漏了。
   */
  { id: 'settings/stt-cloud', page: 'settings', nav: 'settings', seed: 'sttCloud' },
  // 沒有個人參數時是「開始校準」,有參數才換成「重新校準」——兩顆都要被列舉到。
  { id: 'settings/uncalibrated', page: 'settings', nav: 'settings', seed: 'uncalibrated' },
  // 「Ollama 模型」選單只有在「測試連線」成功之後才會渲染。
  { id: 'settings/ollama-connected', page: 'settings', nav: 'settings', seed: 'ollamaConnected' },
  // 準備度卡片的「複製指令」只在有可複製項目的時候存在。
  { id: 'settings/preflight-issues', page: 'settings', nav: 'settings', seed: 'preflightIssues' },
  // 「Ollama 裝好了但一個模型都沒有」是唯一長著「複製指令」鈕的卡片世界
  // (ollamaDown 的世界只有下載鈕)。之前 preflight-copy 之所以「有被列舉到」,
  // 是踩在覆寫清理的錯誤上:__auditForce('preflight.models', null) 的舊語意是
  // 「active + 空模型」而不是解除 —— 殘留的覆寫碰巧讓後續狀態長著複製鈕。
  // 覆寫語意修正後,這個世界必須被**宣告**出來,而不是靠殘留。
  { id: 'settings/preflight-no-model', page: 'settings', nav: 'settings', seed: 'preflightNoModel' },
  { id: 'overlay/expanded', page: 'overlay', nav: 'overlay', seed: 'overlay' },
  { id: 'overlay/pill', page: 'overlay', nav: 'overlay', seed: 'overlayPill' },
  // 播放中才會出現「暫停」(靜止時是「播放」)。
  { id: 'overlay/playing', page: 'overlay', nav: 'overlay', seed: 'overlayPlaying' },
  // 貼鏡形態才有「隱藏」;重點模式才有「上一個/下一個重點」。
  { id: 'overlay/lens', page: 'overlay', nav: 'overlay', seed: 'overlayLens' },
  { id: 'overlay/bullet', page: 'overlay', nav: 'overlay', seed: 'overlayBullet' },
  /**
   * 即時教練提示條**出現**的狀態。
   *
   * 為什麼需要它:提示條是 `panicPhase === 'idle' && (turnYieldHint || coachingHint)`
   * 才掛載的,而教練訊號要真的說到話才會出現(語速過快 / 填充詞 / 冷場)。
   * 五個既有的浮層狀態沒有一個帶著訊號,於是「點提示條靜默這一種」這顆鈕
   * 是**有登記、有探針、卻沒有一個宣告狀態渲染它** —— probe-not-found。
   *
   * 這不是登記過期,是狀態清單少了一格。真實教練訊號依賴麥克風與 Whisper,
   * 稽核環境兩者都不成立,所以用稽核橋 `overlay.coachingHint` 製造出來。
   */
  { id: 'overlay/coaching-hint', page: 'overlay', nav: 'overlay', seed: 'overlayCoaching' },
  /**
   * **已經靜默過一種**之後的狀態。
   *
   * 必須是獨立的一格,不能併進上一格:「恢復全部」這顆鈕的渲染條件是
   * `coachingMuted.length > 0`,也就是**必須先按過靜默才會出現**。
   * 用同一個狀態去列舉兩者,第二顆永遠量不到 —— 而它恰好是使用者
   * 「我明明按過了怎麼又響」時唯一能按回去的那顆。
   */
  { id: 'overlay/coaching-muted', page: 'overlay', nav: 'overlay', seed: 'overlayCoachingMuted' },
  { id: 'dialog/confirm', page: 'dialog', nav: 'scripts', seed: 'dialog' },
  { id: 'toast/stack', page: 'toast', nav: 'dashboard', seed: 'toast' },
  { id: 'crash/screen', page: 'crash', nav: 'dashboard', seed: 'crash' }
]

/**
 * 登記表。
 *
 * 每一筆都是:
 *   key      列舉端會產生的一模一樣的字串(基礎鍵)
 *   step     哪一個稽核步驟負責驗它(給人看的)
 *   exempt   不能驗的話,**必須**寫 category 與 reason。沒有 exempt 也沒被
 *            探針標記 = probe-not-run,紅燈。
 *   note     這個控制項的效果是什麼(報告裡會跟著走,讓讀者不必回頭讀程式)
 */
export const CONTROLS = [
  // ───────────── 總覽 ─────────────
  { key: idKey('dashboard', 'mode-card'), step: 'dashboard', note: '三張模式卡各自導航到不同頁' },
  { key: key('dashboard', 'button', '開始提詞'), step: 'dashboard', note: '用最近一份講稿真的開起浮層' },
  // ── 為什麼這裡少了三筆(2026-10-03)──
  // 「建立第一份講稿 / 個人化校準(語速+視距) / 跑一場錄音轉錄或面試練習」
  // 是舊的「開始三部曲」卡片上的三顆鈕。那張卡已經從總覽頁移除:總覽頁原本
  // 同時有兩張三欄的進度卡(它與 FirstRunSteps 的「3 分鐘上手」),新使用者
  // 一開場看到六個任務、兩套說法。
  //   → 三顆步驟鈕由 onboarding-step 那一筆涵蓋(它以 data-effect-id 為身分,
  //     用途更準:驗的是「三顆各自導到不同頁」,比逐顆比對 label 更嚴)。
  //   → 校準降級成卡片底部的一行提醒 → 下一筆 onboarding-calibration。
  // 留著這三筆的症狀是 probe-not-found:登記著三顆**畫面上已經不存在**的鈕,
  // 而那種紅燈會被誤讀成「有人把鈕刪掉了」而不是「登記表過期了」。
  { key: idKey('dashboard', 'demo-script'), step: 'dashboard', note: '沒有講稿時,範例稿鈕真的建出講稿、開起浮層,並導到講稿頁' },
  { key: key('dashboard', 'button', '提詞'), step: 'dashboard', note: '列表其他講稿的提詞鈕' },
  { key: idKey('dashboard', 'preflight-compact'), step: 'dashboard', note: '準備度橫幅按下去真的到設定頁' },
  // 首次上手卡的三步(建稿/校準/試一次)。三顆鈕指向**三個不同的頁面**,
  // 而它們的文案會隨進度改變(標題、icon、done/blocked 狀態),所以用
  // data-effect-id 固定身分。探針驗的是「三顆鈕真的導到三個不同頁」。
  //
  // key 的前綴是 **onboarding** 而不是 dashboard:卡片宣告了
  // data-effect-scope="onboarding",而列舉端對有 scope 的元件一律以 scope 為準
  // (同一個元件同時出現在總覽與設定頁時,才不會被算成兩顆控制項)。
  { key: idKey('onboarding', 'onboarding-step'), step: 'dashboard', note: '三顆上手步驟各自導到不同頁' },
  // 校準提醒(卡片底部的一行,只在「還沒校準」且卡片還沒收合時渲染)。
  // 它承接了被移除的「開始三部曲」裡唯一不是步驟的那件事。
  { key: idKey('onboarding', 'onboarding-calibration'), step: 'dashboard', note: '校準提醒那一行真的導到校準頁' },
  // 完整的準備度卡片只在設定頁(full 形態);總覽頁是另一顆 compact。
  // 上一版這裡四個都寫 dashboard —— 探針與登記表各自說得通,只是它們在講
  // 不同的東西,而那種錯法不會自己浮出來。
  { key: idKey('settings', 'preflight-toggle'), step: 'settings', note: '展開後真的列出每一項' },
  { key: idKey('settings', 'preflight-recheck'), step: 'settings', note: '重查:重跑金鑰讀取與 Ollama 探測(mock 的 /api/tags 計數必須增加)。標籤會在「重查/檢查中」之間擺,所以用穩定 id 當身分' },
  { key: idKey('settings', 'preflight-copy'), step: 'settings', note: '複製指令,剪貼簿真的拿到那段指令(以稽核橋製造「有指令可複製」的狀態)' },
  { key: idKey('settings', 'preflight-action'), step: 'settings', exempt: { category: EXEMPT_CATEGORY.BROWSER_ENGINE, reason: '這一族包含「下載 Ollama」(會叫出外部瀏覽器)與「前往設定」;導航類由 dashboard 其他卡片與 preflight-compact 覆蓋' } },
  { key: idKey('settings', 'preflight-dismiss'), step: 'settings', exempt: { category: EXEMPT_CATEGORY.BROWSER_ENGINE, reason: '只出現在非擋路項目上,效果是把偏好寫進 localStorage;本機啟動時 OCR 與 Ollama 都可能缺席' } },

  // ───────────── 講稿 ─────────────
  { key: idKey('scripts', 'script-row'), step: 'scripts', note: '選取列表中的講稿,編輯器換成它的內容' },
  { key: key('scripts', 'button', '新講稿'), step: 'scripts', note: 'IndexedDB scripts 真的 +1' },
  { key: key('scripts', 'button', '匯入 .txt / .md'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.NATIVE_DIALOG, reason: '檔案選擇器是作業系統對話框,headless 點不到;匯入的解析由 e2e/scripts-import.spec.ts 以真實檔案覆蓋' } },
  { key: key('scripts', 'input:text', '搜尋講稿'), step: 'scripts', note: '列表真的被過濾' },
  { key: key('scripts', 'button', '建立第一份講稿'), step: 'scripts', note: '空狀態的建立鈕,scripts +1' },
  // 空狀態的第二條路(先看到成品再說)。它與總覽頁那顆 demo-script 做同一件事,
  // 但**是兩顆不同的控制項**(不同頁、不同文案):只登記其中一邊,
  // 另一邊就是覆蓋率的洞。
  { key: idKey('scripts', 'demo-script'), step: 'scripts', note: '空狀態的範例稿鈕真的建出講稿並開起浮層' },
  { key: key('scripts', 'input:text', '講稿標題'), step: 'scripts', note: '改名真的寫進 IndexedDB' },
  { key: key('scripts', 'button', '刪除這份講稿'), step: 'scripts', note: '確認後 scripts 真的 -1' },
  { key: key('scripts', 'button', '儲存'), step: 'scripts', note: '儲存後 dirty 消失、IndexedDB 內容是新的' },
  { key: key('scripts', 'button', '已儲存'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.SAME_CONTROL, reason: '與「儲存」同一顆鈕的 disabled 外觀;行為由「儲存」那條驗' } },
  { key: key('scripts', 'button', '開始提詞'), step: 'scripts', note: '浮層帶到編輯器裡的內容' },
  { key: key('scripts', 'button', '錄影提詞'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.REAL_DESKTOP, reason: '需要真的開攝影機並寫入錄影檔;headless 的假攝影機不足以驗證輸出檔' } },
  { key: idKey('scripts', 'rec-stop'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.REAL_DESKTOP, reason: '錄影迴圈的一部分,同上' } },
  { key: idKey('scripts', 'rec-pause'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.REAL_DESKTOP, reason: '錄影迴圈的一部分,同上' } },
  { key: key('scripts', 'input:checkbox', '這次之後不再顯示倒數'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.REAL_DESKTOP, reason: '只存在於錄影倒數的 3 秒內,且效果是寫 localStorage 偏好' } },
  { key: key('scripts', 'button', '關閉錄影預覽'), step: 'scripts', note: '預覽 modal 真的關掉' },
  { key: key('scripts', 'button', '開啟所在資料夾'), step: 'scripts', exempt: { category: EXEMPT_CATEGORY.DESTRUCTIVE_WINDOW, reason: '會叫出作業系統的檔案總管視窗' } },
  { key: key('scripts', 'button', '關閉'), step: 'scripts', note: '預覽 modal 的次要關閉鈕' },
  { key: idKey('scripts', 'script-body'), step: 'scripts', note: '編輯器內容真的寫進 IndexedDB(逐字稿→講稿的回流也靠它)' },

  // ───────────── 錄音轉錄 ─────────────
  { key: key('record', 'label:checkbox', '我的麥克風'), step: 'record', note: '勾選狀態真的改變收音來源(以「停止後報告的來源」為證據)' },
  { key: key('record', 'label:checkbox', '系統音訊（對方）'), step: 'record', exempt: { category: EXEMPT_CATEGORY.REAL_DESKTOP, reason: '系統音訊走 getDisplayMedia,需要實體桌面與可選視窗;本輪只驗麥克風那條' } },
  { key: key('record', 'input:text', '會議名稱'), step: 'record', note: '輸入的名稱真的成為存檔的標題' },
  { key: key('record', 'button', '開始聆聽'), step: 'record', note: '真的開始收訊、逐字稿出現辨識結果' },
  { key: key('record', 'button', '停止並儲存'), step: 'record', note: 'sessions 真的多一筆且段落非空' },
  /**
   * 會後報告卡的關閉鈕。
   *
   * 它的可及名稱是**會變的**:aria-label 寫「關閉這份報告」,而列舉端對按鈕
   * 優先取可見文字(「關閉」),所以登記成名稱時它是 `record|button|關閉` ——
   * 而那個字串太通用,一旦頁面上多一顆同名的「關閉」就會指錯對象。
   * 用 data-effect-id 當身分,與 ConfirmDialog 的 confirm-ok/cancel 同一個理由。
   */
  { key: idKey('record', 'report-close'), step: 'record', note: '會後報告卡真的消失' },
  /**
   * 「開始聆聽」的啟動中外觀(同一顆鈕的 disabled 面)。
   *
   * 這個狀態**真的會出現**:getUserMedia / Whisper 載入要時間,而按下去之後
   * 到錄音開始之間就是這個文案。它與「開始聆聽」共用同一個行為。
   */
  { key: key('record', 'button', '啟動中…'), step: 'record', exempt: { category: EXEMPT_CATEGORY.SAME_CONTROL, reason: '與「開始聆聽」同一顆鈕的啟動中外觀(disabled);行為由那一條驗' } },
  { key: idKey('record', 'session-row'), step: 'record', note: '展開真的顯示逐字稿明細' },
  // 「複製行動清單」:它的文案是使用者自己取的會議標題(每一列都不同),
  // 用文字當身分會讓每一列變成一顆控制項。用穩定 id。
  // 探針驗的是「剪貼簿真的拿到那份清單」—— 並且順便斷言清單裡**沒有逐字稿**。
  { key: idKey('record', 'copy-action-list'), step: 'record', note: '剪貼簿真的拿到可貼上的行動清單(且不含逐字稿)' },
  { key: key('record', 'button', 'AI 摘要'), step: 'record', note: '摘要真的寫進 sessions.summary 並渲染重點' },
  { key: key('record', 'button', '重新摘要'), step: 'record', note: '已有摘要時的重跑' },
  { key: key('record', 'button', '存成講稿'), step: 'record', note: 'scripts 真的 +1 且只含我方發言' },
  { key: key('record', 'button', '匯出'), step: 'record', exempt: { category: EXEMPT_CATEGORY.NATIVE_DIALOG, reason: '存檔對話框是作業系統的;寫檔本身由 e2e/backup.spec.ts 以真實檔案覆蓋' } },
  { key: key('record', 'button', '刪除這場會議紀錄'), step: 'record', note: '確認後 sessions 真的 -1' },

  // ───────────── 面試練習 ─────────────
  { key: key('practice', 'input:text', '職位或情境'), step: 'practice', note: '輸入的職稱真的進了練習紀錄' },
  { key: idKey('practice', 'practice-type'), step: 'practice', note: '練習類型按鈕:選中的類型真的用於出題' },
  { key: idKey('practice', 'practice-count'), step: 'practice', note: '題數按鈕:真的產出對應題數' },
  { key: key('practice', 'button', '開始練習'), step: 'practice', note: '走完 AI 出題 → 進入 run phase、題目非空' },
  { key: idKey('practice', 'practice-row'), step: 'practice', note: '載入歷史紀錄,逐題內容回到畫面' },
  { key: key('practice', 'button', '刪除這次練習紀錄'), step: 'practice', note: '確認後 practiceRuns 真的 -1' },
  { key: key('practice', 'button', '結束練習'), step: 'practice', note: '回到 setup phase,紀錄保留' },
  { key: key('practice', 'button', '朗讀題目'), step: 'practice', exempt: { category: EXEMPT_CATEGORY.BROWSER_ENGINE, reason: 'Web Speech API 的發音由作業系統語音引擎提供,headless 沒有可觀察的輸出' } },
  { key: key('practice', 'button', '開始回答'), step: 'practice', note: '真的開始收音、逐字稿出現在畫面上' },
  { key: key('practice', 'button', '完成回答，取得反饋'), step: 'practice', note: '走完 STT + AI 評分,分數真的渲染' },
  { key: key('practice', 'button', '下一題'), step: 'practice', note: '題號真的前進' },
  { key: key('practice', 'button', '查看總評'), step: 'practice', note: '最後一題按下後進入 done、總評文字非空' },
  { key: key('practice', 'button', '再練一輪'), step: 'practice', note: '回到 setup phase' },

  // ───────────── 個人化校準 ─────────────
  { key: key('calibration', 'input:number', '瞳距(IPD),單位毫米'), step: 'calibration', note: '改 IPD 真的改變推導出的視距' },
  { key: key('calibration', 'button', '開啟攝影機偵測'), step: 'calibration', note: '假攝影機下影格真的有在流(臉部量測另計)' },
  { key: key('calibration', 'input:number', '沒有攝影機？直接填你平常的觀看距離'), step: 'calibration', note: '手動距離真的進到下一步的推導' },
  { key: key('calibration', 'button', '用手動距離繼續'), step: 'calibration', note: '真的進到 step 1' },
  { key: key('calibration', 'button', '開始朗讀'), step: 'calibration', note: '按下後真的開始收音(假麥克風);語速數值本身需要 Whisper,不在這一條的斷言範圍' },
  { key: key('calibration', 'button', '唸完了'), step: 'calibration', exempt: { category: EXEMPT_CATEGORY.MODEL_DOWNLOAD, reason: '同上一條:停止朗讀後要跑 Whisper 才會有語速結果' } },
  { key: key('calibration', 'button', '下一步'), step: 'calibration', note: '真的進到 step 2' },
  { key: key('calibration', 'button', '−'), step: 'calibration', note: '字級真的變小(預覽與參數同步)' },
  { key: key('calibration', 'button', '+'), step: 'calibration', note: '字級真的變大' },
  { key: key('calibration', 'button', '套用個人化設定'), step: 'calibration', note: 'settings.personal.profile 真的寫入並導向設定頁' },
  { key: key('calibration', 'button', '回上一步'), step: 'calibration', note: '真的退回上一個 step' },

  // ───────────── 設定 ─────────────
  // 頁首的區塊目錄(九顆 chip)。九顆共用一個 data-effect-id:它們的效果是
  // 同一種(捲到對應區塊),逐顆登記會產生九筆只差區塊名的登記項,而區塊
  // 一增減就要改九行 —— 那種登記表最後只會被抄成一份沒有意義的清單。
  { key: idKey('settings', 'settings-toc'), step: 'settings', note: '目錄的區塊鈕按下去真的捲到那一區(主區的捲動位置改變)' },
  { key: idKey('settings', 'provider'), step: 'settings', note: 'AI 供應商切換真的寫進 settings.ai.provider' },
  { key: idKey('settings', 'stt-engine'), step: 'settings', note: '辨識引擎切換真的寫進 settings.stt.engine' },
  { key: idKey('settings', 'scene'), step: 'settings', note: '場景按鈕真的寫進 scenario.activeScene' },
  { key: idKey('settings', 'panic-mode'), step: 'settings', note: 'Panic framing 真的寫進 scenario.panicMode' },
  // 「複製診斷報告」。同一顆鈕在有報告時是「複製診斷報告」、沒有時是 disabled,
  // 但那與 preflight-* 的 disabled 面同一類,不需要單獨一筆。
  // 探針驗的是「剪貼簿真的拿到報告」並且「報告裡沒有敏感欄位」。
  { key: idKey('settings', 'copy-diagnostics'), step: 'settings', note: '剪貼簿真的拿到診斷報告,且報告不含金鑰與逐字稿' },
  { key: key('settings', 'button', '測試連線'), step: 'settings', note: '連線失敗時真的跳錯誤 toast,連得上時不跳' },
  // 鍵名要跟畫面上的字一樣:「分享前模擬測試」。
  // 上一版寫成「模擬分享畫面」—— 而列舉端永遠不會產生那個字串,
  // 於是這一筆登記從未對應到任何東西(它不報錯,只是安靜地什麼也沒覆蓋)。
  // 現在假裝置軍提供了可選的主畫面來源,它從 exempt 變成真的量得到。
  { key: key('settings', 'button', '分享前模擬測試'), step: 'settings', note: '畫面真的多出一張擷取縮圖(以假裝置的 --auto-select-desktop-capture-source)' },
  { key: key('settings', 'button', '重新校準'), step: 'settings', note: '導航到校準頁' },
  { key: key('settings', 'button', '開始校準'), step: 'settings', note: '導航到校準頁' },
  { key: key('settings', 'button', '開啟記錄資料夾'), step: 'settings', exempt: { category: EXEMPT_CATEGORY.DESTRUCTIVE_WINDOW, reason: '會叫出作業系統的檔案總管' } },
  { key: key('settings', 'button', '匯出備份'), step: 'settings', exempt: { category: EXEMPT_CATEGORY.NATIVE_DIALOG, reason: '存檔對話框;備份內容本身由 audit 的 backup.probe 與 e2e/backup.spec.ts 覆蓋' } },
  { key: key('settings', 'button', '還原備份'), step: 'settings', exempt: { category: EXEMPT_CATEGORY.NATIVE_DIALOG, reason: '開檔對話框;還原語意由 backup.restore 探針覆蓋' } },
  { key: idKey('settings', 'switch'), step: 'settings', note: '每一個開關都必須真的翻轉它對應的設定' },

  // ── 設定頁:提詞浮層的外觀欄位 ──
  // 六個滑桿各驗一次(方向鍵一步 → 資料層跟著動)。
  { key: key('settings', 'input:range', '藥丸大小'), step: 'settings', note: '拖動真的寫進 overlay.pillScale' },
  { key: key('settings', 'input:range', '字體大小'), step: 'settings', note: '拖動真的寫進 overlay.fontSize' },
  { key: key('settings', 'input:range', '滾動速度'), step: 'settings', note: '拖動真的寫進 overlay.speed' },
  { key: key('settings', 'input:range', '語速倍率'), step: 'settings', note: '拖動真的寫進 overlay.rate' },
  { key: key('settings', 'input:range', '行距'), step: 'settings', note: '拖動真的寫進 overlay.lineHeight' },
  { key: key('settings', 'input:range', '不透明度'), step: 'settings', note: '拖動真的寫進 overlay.opacity' },
  { key: key('settings', 'button', '連續捲動'), step: 'settings', note: '選了真的把 overlay.displayMode 換成 scroll' },
  { key: key('settings', 'button', '逐句短語'), step: 'settings', note: '同上,phrase' },
  { key: key('settings', 'button', '重點要點'), step: 'settings', note: '同上,bullet(浮層的上下一個重點只在這個模式存在)' },
  { key: key('settings', 'button', '逐詞高亮'), step: 'settings', note: '同上,karaoke' },

  // ── 設定頁:兩組 API 欄位 + Ollama 模型選單 ──
  // 六個欄位的可及名稱兩兩相同(一組雲端辨識、一組 AI 助理),
  // 所以以 data-effect-id 當身分 —— 用名稱的話 `.first()` 永遠拿到前一組,
  // 而那種錯誤會把一顆好的控制項記成壞的(實際發生過)。
  { key: idKey('settings', 'stt-base-url'), step: 'settings', note: '寫進 stt.cloud.baseUrl' },
  { key: idKey('settings', 'stt-model'), step: 'settings', note: '寫進 stt.cloud.model' },
  { key: idKey('settings', 'stt-api-key'), step: 'settings', note: '金鑰寫進作業系統安全儲存(sttApiKey)' },
  { key: idKey('settings', 'ai-base-url'), step: 'settings', note: '寫進 ai.openaiCompatible.baseUrl' },
  { key: idKey('settings', 'ai-model'), step: 'settings', note: '寫進 ai.openaiCompatible.model' },
  { key: idKey('settings', 'ai-api-key'), step: 'settings', note: '金鑰寫進作業系統安全儲存(apiKey)' },
  { key: idKey('settings', 'ollama-model'), step: 'settings', note: '選了真的寫進 ai.ollama.model(測試連線成功後才會渲染)' },
  // 這一筆是被**負向驗證**抓出來的:探針寫了十幾輪,但登記表一直漏了它。
  // 舊的 no-effect-probe 規則寫著「沒有探針才算漏」,所以它在報告裡
  // 一直是一顆「已驗證、卻沒有任何說明」的控制項。規則改嚴之後它立刻變紅。
  { key: key('settings', 'input:text', 'Ollama 位址'), step: 'settings', note: '寫進 ai.ollama.baseUrl(後面整條本地 AI 路徑都靠它)' },

  // ── 設定頁:六個熱鍵下拉 ──
  { key: key('settings', 'select', '顯示 / 隱藏浮層'), step: 'settings', note: '寫進 hotkeys.toggleOverlay' },
  { key: key('settings', 'select', '隱藏浮層'), step: 'settings', note: '寫進 hotkeys.hideOverlay' },
  { key: key('settings', 'select', 'Panic 救援'), step: 'settings', note: '寫進 hotkeys.panicRescue' },
  { key: key('settings', 'select', '播放 / 暫停'), step: 'settings', note: '寫進 hotkeys.playPause' },
  { key: key('settings', 'select', '加快語速'), step: 'settings', note: '寫進 hotkeys.speedUp' },
  { key: key('settings', 'select', '減慢語速'), step: 'settings', note: '寫進 hotkeys.speedDown' },
  { key: key('settings', 'select', '語言'), step: 'settings', note: '寫進 stt.language' },
  { key: key('settings', 'select', '本地模型'), step: 'settings', note: '寫進 stt.localModel' },

  // ───────────── 浮層 ─────────────
  { key: key('overlay', 'button', '播放'), step: 'overlay', note: '捲動位置真的前進' },
  { key: key('overlay', 'button', '暫停'), step: 'overlay', note: '捲動位置真的停住' },
  { key: key('overlay', 'button', '收合成藥丸'), step: 'overlay', note: 'surface 真的變 pill 且設定寫入' },
  { key: key('overlay', 'button', '展開完整面板'), step: 'overlay', note: 'surface 真的回到 expanded' },
  { key: key('overlay', 'button', '速度 +'), step: 'overlay', note: 'overlay.speed 真的 +10' },
  { key: key('overlay', 'button', '速度 -'), step: 'overlay', note: 'overlay.speed 真的 -10' },
  { key: key('overlay', 'button', '模式'), step: 'overlay', note: 'overlay.displayMode 真的切換' },
  { key: key('overlay', 'button', 'A+'), step: 'overlay', note: 'overlay.fontSize 真的變大(鈕上文字是 A+;title 是「字體放大」)' },
  { key: key('overlay', 'button', 'A-'), step: 'overlay', note: 'overlay.fontSize 真的變小' },
  { key: key('overlay', 'button', 'Panic 救援'), step: 'overlay', note: '離線模板卡真的出現在浮層裡' },

  // ───────────── 對話框 / toast / 崩潰 ─────────────
  { key: idKey('dialog', 'confirm-ok'), step: 'dialogs', note: '確認鈕真的執行破壞性操作' },
  { key: idKey('dialog', 'confirm-cancel'), step: 'dialogs', note: '取消鈕必須完全不改變資料(負向斷言)' },
  { key: key('toast', 'button', '關閉通知'), step: 'toast', note: 'toast 真的被移除' },
  // 可行動錯誤的按鈕(「前往設定」/「下載 Ollama」…)。它的**名稱會變**
  // —— 同一顆鈕依錯誤碼顯示不同的 label —— 所以必須用 data-effect-id。
  // 探針驗的是「按下去真的換頁」而不是「按下去沒有反應」。
  { key: idKey('toast', 'toast-action'), step: 'toast', note: '錯誤 toast 的行動按鈕真的導到那一頁' },
  { key: key('crash', 'button', '重新載入'), step: 'crash', exempt: { category: EXEMPT_CATEGORY.DESTRUCTIVE_WINDOW, reason: '重載會終止稽核視窗本身;由 e2e/error-boundary.spec.ts 覆蓋' } },
  { key: key('crash', 'button', '複製錯誤詳細資料'), step: 'crash', note: '剪貼簿真的拿到診斷內容' },
  { key: key('crash', 'button', '開啟記錄資料夾'), step: 'crash', exempt: { category: EXEMPT_CATEGORY.DESTRUCTIVE_WINDOW, reason: '會叫出作業系統的檔案總管' } },

  // ───────────── 側欄導航(六頁) ─────────────
  { key: key('nav', 'button', '總覽'), step: 'nav', note: 'hash 與 main 內容都真的換了' },
  { key: key('nav', 'button', '提詞講稿'), step: 'nav', note: '同上' },
  { key: key('nav', 'button', '錄音轉錄'), step: 'nav', note: '同上' },
  { key: key('nav', 'button', '面試練習'), step: 'nav', note: '同上' },
  { key: key('nav', 'button', '個人化校準'), step: 'nav', note: '同上' },
  { key: key('nav', 'button', '設定'), step: 'nav', note: '同上' },

  // ───────────── 浮層工具列(第二輪補上的) ─────────────
  { key: key('overlay', 'button', '隱藏'), step: 'overlay', note: '浮層真的收起來' },
  { key: key('overlay', 'button', '關閉'), step: 'overlay', note: '同上(同一條 overlayHide)' },
  { key: key('overlay', 'button', '貼鏡模式'), step: 'overlay', note: 'surface 真的變 lens' },
  /**
   * 貼鏡形態專屬的四顆。
   *
   * 上一版它們全部被報成「沒有探針」,因為登記表裡只有「貼鏡模式」那條 ——
   * 而貼鏡形態的工具列是**另一套按鈕**:三顆角落吸附 + 退出。
   * 「退出貼鏡模式」與「貼鏡模式」是同一個動作的兩面(同一條行為),
   * 而角落吸附三顆是真的視窗移動(量的是 bounds,不是自己說什麼)。
   */
  { key: key('overlay', 'button', '退出貼鏡模式'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.SAME_CONTROL, reason: '與「貼鏡模式」同一個切換的「已在貼鏡中」外觀;行為由那一條驗(surface lens → expanded)' } },
  { key: key('overlay', 'button', '↖ 左上'), step: 'overlay', note: '視窗真的移到螢幕左上角(bounds 改變)' },
  { key: key('overlay', 'button', '↑ 上中'), step: 'overlay', note: '視窗真的移到螢幕上緣正中' },
  { key: key('overlay', 'button', '↗ 右上'), step: 'overlay', note: '視窗真的移到螢幕右上角' },
  // 無障礙名稱來自鈕上的文字(↺),不是 title(回到開頭)—— 以列舉端會產生的那個為準。
  // 寫 title 的話兩邊都說得通,只是永遠對不上(而那種錯不會自己浮出來)。
  { key: key('overlay', 'button', '↺'), step: 'overlay', note: '捲動位置真的回到 0' },
  { key: key('overlay', 'button', '下一個重點'), step: 'overlay', note: '捲動位置真的前進' },
  { key: key('overlay', 'button', '上一個重點'), step: 'overlay', note: '捲動位置真的後退' },
  { key: key('overlay', 'button', '鏡像'), step: 'overlay', note: 'overlay.mirror 真的翻轉' },
  { key: key('overlay', 'button', '螢幕擷取隱形'), step: 'overlay', note: 'overlay.captureProtected 真的翻轉' },
  { key: key('overlay', 'button', '滑鼠穿透'), step: 'overlay', note: 'overlay.clickThrough 真的翻轉' },
  { key: key('overlay', 'button', '浮層置中'), step: 'overlay', note: '視窗 bounds 真的回到螢幕中央' },
  { key: key('overlay', 'button', '開啟「該你說話了」提示'), step: 'overlay', note: '按下真的把 overlay.turnYield 打開' },
  /**
   * 即時教練的靜音控制。
   *
   * 兩顆都要登記,因為它們是**互補**的:靜音鈕只在提示條出現時存在,
   * 取消靜音鈕只在「本場已靜默 N 種」時存在。少登記任何一顆,
   * 「使用者能不能把提示關掉、又能不能找回來」就有一半永遠沒有人驗。
   *
   * 用 data-effect-id 而不是 title:提示條的文字是教練建議本身
   * (每一則建議不同),「本場已靜默:…」則會列出靜默了哪幾種。
   */
  { key: idKey('overlay', 'coaching-mute'), step: 'overlay', note: '按下真的讓這一種提示不再出現(本場內)' },
  { key: idKey('overlay', 'coaching-unmute'), step: 'overlay', note: '恢復全部真的讓「已靜默」列消失' },
  { key: key('overlay', 'button', '關閉「該你說話了」提示'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.SAME_CONTROL, reason: '同一顆開關的「已開啟」外觀;行為由「開啟…」那條驗' } },
  { key: key('overlay', 'button', '開啟即時教練'), step: 'overlay', note: '按下真的把 overlay.coaching 打開' },
  { key: key('overlay', 'button', '即時教練開啟中'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.SAME_CONTROL, reason: '同一顆開關的「已開啟」外觀;行為由「開啟即時教練」那條驗' } },
  { key: key('overlay', 'button', '語音跟讀'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.MODEL_DOWNLOAD, reason: '跟讀需要本地 Whisper 模型 + 真麥克風才能判斷「唸到哪」' } },
  { key: key('overlay', 'button', '語速 +'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.MODEL_DOWNLOAD, reason: '語速基準來自個人校準(需要 Whisper 量出語速),未校準時按鈕停用' } },
  { key: key('overlay', 'button', '語速 -'), step: 'overlay', exempt: { category: EXEMPT_CATEGORY.MODEL_DOWNLOAD, reason: '同上' } }
]

/** 登記表的索引(基礎鍵 → 條目)。重複登記同一個鍵在載入時就是錯誤。 */
export function buildRegistry(controls = CONTROLS) {
  const map = new Map()
  const dup = []
  for (const c of controls) {
    const k = baseKey(c.key)
    if (map.has(k)) dup.push(k)
    map.set(k, c)
  }
  if (dup.length) throw new Error(`effect-inventory 有重複登記的控制項:${dup.join(', ')}`)
  return map
}

/**
 * 頁面內的控制項列舉。
 *
 * **這支函式的原始碼會被序列化送進頁面執行**(與 domAudit 同一個契約):
 * 不得引用模組層級的識別字,也不得用 Node API。所以它完全自足。
 *
 * 回傳的 key 規則必須與上面的 key()/idKey() 一致 —— 這是整個覆蓋率檢查的
 * 唯一接縫,改這裡就要改那裡(反之亦然)。
 */
/**
 * 列舉。引數是一個物件而不是兩個參數:page.evaluate(fn, arg) 只傳一個引數,
 * 兩個參數的簽名會讓 scope 永遠是 undefined —— 而那會讓對話框狀態把整頁
 * 的控制項都算進來(一個安靜的錯誤,不會有人發現)。
 */
export function ENUMERATE({ pageId, scope }) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  /**
   * title 的收斂規則。**必須與 audit 端點擊時的比對規則一模一樣** ——
   * 兩邊不一致的症狀是:對帳說某顆控制項有登記,而點擊卻點到另一顆
   * (實際發生過:浮層的「關閉(浮層)」被 `startsWith('關閉')` 誤配到
   * 「關閉『該你說話了』提示」,於是量到的「按了關閉但浮層還在」是假的)。
   */
  const cutTitle = (title) => {
    const cut = title.split(/[（(:：]/)[0].trim()
    return cut.length >= 2 ? cut : title
  }
  // 範圍:對話框與 toast 只掃它們自己那一塊。
  // 不這樣做的話,對話框開著時底下整頁的控制項都會被算成「dialog 這一頁」的
  // 控制項 —— 於是覆蓋率會出現一堆不存在的東西(而它們其實已經在各自的頁上被算了)。
  const root_ = scope ? document.querySelector(scope) : document
  if (!root_) return []
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    let n = el
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
      n = n.parentElement
    }
    return true
  }
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'input') return 'input:' + (el.getAttribute('type') || 'text').toLowerCase()
    const role = el.getAttribute('role')
    if (role) return role
    return 'button'
  }
  /**
   * 可及名稱。
   *
   * 工具列的 title 帶著捷徑與狀態(「暫停(空白鍵)」、「Panic 救援(Alt+P)」、
   * 「語速 -（1×＝你的個人語速 240 字/分）」)——那些字串一變,key 就跟著變,
   * 於是覆蓋率永遠對不上。所以**只對來自 title 的名稱**做一次收斂:
   * 在第一個括號或冒號處切斷。
   *
   * 只處理 title 的理由:那是唯一一個「作者會把補充說明寫進去」的欄位。
   * textContent 與 aria-label 是內容本身(「會議中斷/卡詞」、「關閉通知」),
   * 在那裡切字會把不同的控制項壓成同一個 key。
   */
  const nameOf = (el) => {
    const label = el.closest('label')
    const tag = el.tagName.toLowerCase()
    const aria = norm(el.getAttribute('aria-label'))
    /**
     * <select> 的 textContent 是**所有選項的文字串在一起**。
     * 先前的規則(文字優先)會把六個熱鍵下拉變成
     * `settings|select|Ctrl+Alt+TCtrl+Alt+PCtrl+Shift+SpaceCtrl+Alt+0` —— 一個
     * 既讀不懂、又會隨選項清單變動的字串,而那正是本檔開頭說要避免的漂移。
     * 有 aria-label 的下拉一律用它;沒有的話退回 title,再退回目前選中的選項。
     */
    if (tag === 'select') {
      if (aria) return aria
      const title = norm(el.getAttribute('title'))
      if (title) return cutTitle(title)
      const selected = norm(el.selectedOptions?.[0]?.textContent)
      return selected || '(無名稱)'
    }
    /**
     * <textarea> 的 textContent 是**使用者打進去的內容**，不是身分。
     *
     * 這裡原本走「文字優先」，於是鍵變成
     * `scripts|textarea|內容:稽核講稿二。這是一段夠長的示範內容。` ——
     * **內容一改，key 就跟著改**，登記表永遠對不上。
     * 實測症狀：登記表寫的是 `scripts|textarea|(無名稱)`，而列舉出來的是
     * `scripts|textarea|內容:…`，於是這顆控制項每次都被報成
     * 「有登記，但沒有任何一個被宣告的狀態裡出現過它」。
     *
     * 這正是本檔開頭寫著要避免的那種漂移，只是它不是來自 title 的補充說明，
     * 而是來自**使用者的資料**。textarea 的可及名稱只能來自
     * aria-label / title / placeholder，沒有的話就是「沒有名字」。
     */
    if (tag === 'textarea') {
      if (aria) return aria
      const title = norm(el.getAttribute('title'))
      if (title) return cutTitle(title)
      return norm(el.getAttribute('placeholder')) || '(無名稱)'
    }
    const text = norm(el.textContent)
    if (text) return text
    if (aria) return aria
    const title = norm(el.getAttribute('title'))
    if (title) return cutTitle(title)
    return (
      norm(el.getAttribute('placeholder')) ||
      norm(el.value) ||
      (label ? norm(label.textContent) : '') ||
      '(無名稱)'
    )
  }

  const selector =
    'button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=button], [role=checkbox], [role=tab]'

  /**
   * 控制項的歸屬範圍。
   *
   * 側欄、toast、準備度卡片是**跨頁面的同一個元件**(PreflightCard 同時出現在
   * 總覽與設定頁;側欄每一頁都有)。以「你現在在哪一頁」當 key 的話,同一顆
   * 控制項會在六個頁面上被算成六顆 —— 覆蓋率會出現 42 筆假的「沒有探針」,
   * 而真正的缺口會埋在裡面看不出來。
   * 有 data-effect-scope 的祖先時,範圍以它為準(元件作者明確說「我跟頁面無關」)。
   */
  const scopeOf = (el) => {
    const owner = el.closest('[data-effect-scope]')
    return owner ? owner.getAttribute('data-effect-scope') : pageId
  }

  const out = []
  for (const el of Array.from(root_.querySelectorAll(selector))) {
    // label 內的輸入框:使用者實際點的是整個 label(與 domAudit 的 isSmallTarget 同一條理由),
    // 所以以 label 為控制項,裡面的 input 不另外算一顆 —— 否則同一個開關會被算兩次,
    // 而覆蓋率會出現一個永遠沒有探針的「影子控制項」。
    const label = el.closest('label')
    const target = label && label.querySelector('input') === el ? label : el
    if (!visible(target)) continue

    const scopePage = scopeOf(target)
    const effectId = target.getAttribute('data-effect-id')
    if (effectId) {
      out.push({ key: `${scopePage}|id:${effectId}`, role: 'dataeffect', name: effectId, disabled: false, byId: true })
      continue
    }

    const role = label && target === label ? 'label:' + (el.getAttribute('type') || 'checkbox').toLowerCase() : roleOf(target)
    out.push({
      key: `${scopePage}|${role}|${nameOf(target)}`,
      role,
      name: nameOf(target),
      disabled: target.disabled === true || target.getAttribute('aria-disabled') === 'true',
      byId: false
    })
  }

  // 重複的鍵加上序號(列表的每一列),基礎鍵不變。
  const seen = new Map()
  for (const c of out) seen.set(c.key, (seen.get(c.key) || 0) + 1)
  const idx = new Map()
  return out.map((c) => {
    if (seen.get(c.key) === 1) return c
    const n = (idx.get(c.key) || 0) + 1
    idx.set(c.key, n)
    return { ...c, key: `${c.key}#${n}` }
  })
}
