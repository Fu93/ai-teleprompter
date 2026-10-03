/**
 * launch.ts — 啟動 App 並**正確分辨主視窗與浮層**。
 *
 * 為什麼需要這個檔案:
 *   `app.firstWindow()` **不保證是主視窗**。主視窗與浮層都是
 *   `loadFile('../renderer/index.html')`,同一個檔案、同一個路徑,浮層只多一個
 *   `#/overlay` hash。而 createOverlayWindow() 可能比主視窗的 ready-to-show 更早
 *   完成 load,所以 firstWindow() 拿到浮層是**真的會發生**的事。
 *
 *   症狀非常難認:浮層是一個「0:00 / -0:00、尚未載入講稿」的小視窗,裡面
 *   **沒有側欄、沒有頁面按鈕、沒有 `.toast-item`**。於是所有
 *   `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('開始聆聽'))`
 *   都回傳 undefined、`?.click()` 靜默 no-op,然後測試在 30 秒後以
 *   「Timeout exceeded while waiting on the predicate」失敗 —— **看不出真正原因**。
 *
 *   這個坑本專案已經踩過兩次:
 *     1. 打包後驗證時,`firstWindow()` 拿到浮層,於是我差點把「設定頁沒有備份功能」
 *        寫成結論(靠多問一步才沒寫)。
 *     2. `audit-states.mjs` 因此在選主視窗,而其他 spec 沒有 —— 這份檔案
 *        就是把那個更好的做法收斂成一個共用函式。
 *
 * 判斷主視窗的方式是 **`aside`(側欄)**:只有主視窗有。不用 URL 是因為
 * dev 模式下 `ELECTRON_RENDERER_URL` 與檔案模式的 hash 行為不同,URL 判斷
 * 會在兩種模式間各自出錯一次(這也是 user-journey.spec.ts 用 URL 判斷、
 * 但 dev 與打包兩種跑法行為不一致的原因)。
 *
 * 附帶回傳診斷資訊:失敗時 `describeE2E` 會把熱鍵衝突、視窗數、URL 一起印出來。
 * 這是為了讓「下一次失敗」不需要再猜 —— 本專案已經有過四次「單獨跑就綠、
 * 全量跑就紅」的 flake,而前三次都因為失敗當下沒有任何證據而查不出根因。
 */
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

export interface Launched {
  app: ElectronApplication
  main: Page
  /** 浮層;還沒建立時是 undefined(有些測試全程不需要它) */
  overlay: Page | undefined
  /** 失敗時印出來用的診斷快照 */
  diagnose: () => Promise<string>
}

/** 這個視窗是不是主視窗:只有主視窗有側欄。 */
async function isMain(win: Page): Promise<boolean> {
  return win
    .evaluate(() => !!document.querySelector('aside'))
    .catch(() => false)
}

/**
 * 啟動 App 並等到主視窗真的渲染出側欄。
 *
 * 為什麼要輪詢而不是只等 domcontentloaded:浮層與主視窗幾乎同時 load,
 * firstWindow() 可能回傳任一個,而「選對視窗」需要等 React 真的把 aside 畫上去。
 * 60 次 × 250ms = 最多 15 秒,遠超過任何健康環境需要的時間(實測 < 2 秒),
 * 所以逾時代表真的有問題而不是環境慢。
 */
export async function launchApp(env?: Record<string, string | undefined>): Promise<Launched> {
  // electron.launch 的 env 型別不接受 undefined 值,而呼叫端常直接傳 process.env。
  const cleanEnv = env
    ? (Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>)
    : undefined
  /**
 * 預設帶上假裝置的旗標,不是因為「測試不需要麥克風」,而是因為**真實麥克風
 * 讓測試不再可重現**。
 *
 * 實測(同一台機器、同一份程式碼、`--repeat-each=2`):
 *   不帶假裝置:4 個用例 → 1 過 3 敗(失敗全是「等待說話…」一直不消失)
 *   帶假裝置  :4 個用例 → 4 過
 * 而失敗的那三個不是「今天機器慢」:它們的症狀是 VAD 從真實音訊切不出段落,
 * 與被測行為(退出前 flush)完全無關,卻讓一條 blocking 測試擋住 merge。
 *
 * CI 更沒有選擇:`windows-latest` 上**沒有任何音訊輸入裝置**,真實麥克風那條路
 * 在 CI 上是 100% 失敗,不是偶發。
 *
 * 為什麼不動「麥克風被拒」那條測試:它靠 helpers/env.ts 在**邊界**注入失敗
 * (見 mic-denied.spec.ts 的檔頭),本來就不依賴裝置真的不存在 —— 這是這個 repo
 * 少數做對的隔離方式。
 *
 * 需要「真的沒有麥克風」的用例請自己 electron.launch(不用這個 helper),
 * 並在檔頭寫明理由。
 */
const DEFAULT_ARGS = ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

  const app = await electron.launch({ args: DEFAULT_ARGS, timeout: 60_000, env: cleanEnv })

  let main: Page | undefined
  for (let i = 0; i < 60 && !main; i++) {
    for (const w of app.windows()) {
      if (await isMain(w)) {
        main = w
        break
      }
    }
    // 注意:ElectronApplication 沒有 waitForTimeout(那是 Page 的 API)。
    // 用 setTimeout 睡,不要想當然寫 app.waitForTimeout —— typecheck 不會擋,
    // 但執行時會是「app.waitForTimeout is not a function」而兩個測試都死。
    if (!main) await new Promise((r) => setTimeout(r, 250))
  }
  if (!main) {
    // 收尾:不要留一個孤兒 Electron 在背景搶熱鍵(這正是先前 flake 的機制之一)
    await app.close().catch(() => {})
    throw new Error(
      `15 秒內沒有任何視窗渲染出側欄。實際視窗:${await describeWindows(app)}`
    )
  }
  await main.waitForLoadState('domcontentloaded')

  // 浮層是選用的:有些測試(如 backup)全程不碰它,不該為了等它而拖慢
  const overlay = app.windows().find((w) => w !== main)

  const diagnose = async (): Promise<string> => {
    const info = await main
      .evaluate(() => window.api?.appInfo?.())
      .catch((e: unknown) => `appInfo 失敗:${String(e)}`)
    return [
      `視窗數:${app.windows().length}`,
      `各視窗:${await describeWindows(app)}`,
      `hotkeyConflicts:${JSON.stringify((info as { hotkeyConflicts?: string[] } | undefined)?.hotkeyConflicts ?? '(欄位不存在)')}`,
      `appInfo:${JSON.stringify(info)}`
    ].join('\n  ')
  }

  return { app, main, overlay, diagnose }
}

/** 把每個視窗的 URL / 標題 / 有沒有側欄列成一行,失敗訊息裡最有用的一段。 */
async function describeWindows(app: ElectronApplication): Promise<string> {
  const rows = await Promise.all(
    app.windows().map(async (w, i) => {
      const info = await w
        .evaluate(() => ({
          url: location.href.slice(-40),
          title: document.title,
          hasAside: !!document.querySelector('aside')
        }))
        .catch(() => ({ url: '(無法讀取)', title: '(無法讀取)', hasAside: false }))
      return `#${i} ${info.url} title=${JSON.stringify(info.title)} aside=${info.hasAside}`
    })
  )
  return rows.join(' | ')
}
