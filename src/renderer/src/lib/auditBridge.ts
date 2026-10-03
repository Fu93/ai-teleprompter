/**
 * auditBridge.ts — 把 App 強制推進到「headless 到不了的狀態」的單一入口。
 *
 * 為什麼需要這條橋:
 *   離線稽核(scripts/audit-deep.mjs)原本是在頁面上用文字 regex 找按鈕再
 *   `.click()`。找不到就靜默 no-op,而 React 狀態沒變的結果與「這個狀態沒問題」
 *   在截圖與報告上長得一模一樣。上一輪的具體後果:個人化校準的第 1/2 步
 *   (第一步要有相機或手動距離、第二步要有麥克風量出來的語速)從來沒有被渲染過,
 *   但 `calibration.png`、`calibration-step1.png`、`calibration-step2.png`
 *   三張的 sha256 完全相同,而報告是一份漂亮的空清單。
 *
 * 設計:
 *   - 元件以「名字 + 設值函式」註冊(見 registerAuditControl)。註冊本身沒有成本
 *     (就一個 Map 條目),所以可以無條件註冊,不必在元件裡散落條件判斷。
 *   - 只有 main 回報 `appInfo().audit === true` 時才會把 window.__auditForce
 *     掛出去。打包版永遠沒有這條路徑(AUDIT 定義在 src/main/debug.ts)。
 *   - 刻意不掛任何可見 UI:稽核跑的是 DOM 稽核,多一個元件就會被自己的規則報出來。
 */

/**
 * 控制項可以回傳的結果:
 *   - boolean / void:「做完了」或「做不了」(現有控制項的用法,全部同步)
 *   - object:控制項需要把東西帶回測試端時用(例如備份探針要回傳序列化結果)
 *   - Promise:以上兩者的非同步版本
 *
 * 為什麼要擴成這樣而不是要求全部非同步:
 *   現有的稽核腳本(audit-deep / audit-ui / audit-states)讀的是**同步**的
 *   `.ok`(例:audit-deep.mjs 的 `.evaluate(([n,a]) => window.__auditForce?.(n,a) ?? {ok:false})`)。
 *   把整個橋改成 async 會讓那三支全部要改,而且它們目前是好的。
 *   所以:控制項同步就回傳物件,非同步就回傳 Promise —— 兩種都能被
 *   `await`(Playwright 的 evaluate 與稽核腳本的 await 都吃這個)。
 */
import type { ToastAction } from './toast'

export type AuditControlResult = boolean | void | Record<string, unknown>

type AuditControl = (arg: unknown) => AuditControlResult | Promise<AuditControlResult>

const registry = new Map<string, AuditControl>()

/**
 * 註冊一個可被稽核腳本呼叫的控制項。
 * 回傳註銷函式(元件卸載時呼叫,避免同一個名字被舊的閉包蓋住)。
 */
export function registerAuditControl(name: string, fn: AuditControl): () => void {
  registry.set(name, fn)
  return () => {
    // 只有還是我自己時才刪,避免 A 卸載時把 B 剛註冊的同一名字刪掉
    if (registry.get(name) === fn) registry.delete(name)
  }
}

export interface AuditForceResult {
  ok: boolean
  error?: string
  /** 目前註冊了哪些控制項。找不到名字時最有用的資訊就是這份清單。 */
  names: string[]
  /** 控制項回傳的內容(僅在控制項有回傳時出現) */
  result?: unknown
}

/**
 * 實際的強制入口。回傳值必須是 JSON 可序列化的 —— 它會被
 * executeJavaScript / page.evaluate 傳回 Node 端。
 *
 * **注意:控制項是非同步時,這裡回傳的是 Promise。** 呼叫端一律用 await
 * (稽核腳本與 e2e 都是),所以兩種情況寫法相同。
 */
export function forceAuditState(name: string, arg: unknown): AuditForceResult | Promise<AuditForceResult> {
  const names = [...registry.keys()]
  const fn = registry.get(name)
  if (!fn) return { ok: false, error: `沒有名為 ${name} 的控制項`, names }
  let out: AuditControlResult | Promise<AuditControlResult>
  try {
    out = fn(arg)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), names }
  }
  if (out instanceof Promise) {
    return out.then(
      (v) => ({ ok: v !== false, names, ...(typeof v === 'object' && v !== null ? { result: v } : {}) }),
      (err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        names
      })
    )
  }
  return { ok: out !== false, names, ...(typeof out === 'object' && out !== null ? { result: out } : {}) }
}

/**
 * toast 的強制入口。為什麼要特別開一個:
 *   toast 是 renderer 內部的短命狀態,沒有任何 UI 走得到「錯誤/info/成功同時在畫面上」
 *   這個組合 —— 只能真的讓某件事失敗。而它在這個 App 裡是最重要的一層:
 *   上一輪把錯誤 toast 的停留時間從 4 秒拉到 12 秒,理由是「錯誤不能被錯過」;
 *   而「對話框開著時錯誤 toast 會不會被 55% 黑遮罩壓暗」這種事,只有真的
 *   把兩者放在一起才量得到。拿不到這個入口,那兩個結論都只是推理。
 *
 * 與 forceAuditState 分開(而不是塞進 args):toast 不是「設定狀態」而是「產生事件」,
 *   而且稽核要的正是這個事件本身。
 *
 * ⚠️ action 必須原樣傳下去(第三個參數)。原本這個橋只接( kind, message ),
 *   把 action 丟掉了 —— 結果是**可行動錯誤的按鈕在稽核裡根本造不出來**:
 *   沒有任何一個「造出錯誤 toast」的入口會產生一則帶按鈕的 toast。
 *   那一顆按鈕是這輪改動裡最重要的使用者面向成果(帶著「前往設定」),
 *   而它沒有探針等於它在發布閘門裡是隱形的。
 */
export function installToastBridge(
  push: (kind: 'error' | 'success' | 'info', message: string, action?: ToastAction) => void
): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __auditToast?: typeof push }
  if (w.__auditToast) return
  w.__auditToast = push
}

/** 掛上 window.__auditForce。重複呼叫是安全的。 */
export function installAuditBridge(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __auditForce?: typeof forceAuditState }
  if (w.__auditForce) return
  w.__auditForce = forceAuditState
}

/** 只在稽核模式安裝。由 main.tsx 在啟動時呼叫一次。 */
export function initAuditBridge(): void {
  if (typeof window === 'undefined' || !window.api?.appInfo) return
  void window.api
    .appInfo()
    .then((info) => {
      if (info?.audit) installAuditBridge()
    })
    .catch(() => undefined)
}

/** 目前註冊的控制項名稱(給除錯面板顯示用)。 */
export function listAuditControls(): string[] {
  return [...registry.keys()]
}
