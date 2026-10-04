/**
 * auditBridge.ts — 稽核橋接(window.__auditForce)的**型別**。
 *
 * 為什麼值得一個檔:稽核橋接是 e2e 與稽核腳本改變 App 狀態的唯一入口,而它
 * 在 spec 裡原本一律寫成 `(window as any).__auditForce?.(...)` —— 13 個 any
 * 全部來自同一個未宣告的 global。那不是 13 個各自獨立的|type|問題,而是**一個**
 * 缺口散落在三支 spec 裡;型別一旦補上,那 13 處會一起消失,而且下一次新增
 * 探針的人不必再抄一次 `as any`(抄一次就多一個沒有查的呼叫)。
 *
 * 形狀來自 renderer 端的註冊處(LayoutDebugLayer / audit bridge 的回應格式):
 *   { ok: boolean, result?: T, error?: string }
 * 橋接不存在時回傳明確的失敗,而不是 undefined —— 「沒接上」必須是紅燈。
 */
import type { Page } from 'playwright'

/** 備份探針回報的各類資料筆數。 */
export interface BackupCounts {
  scripts: number
  sessions: number
  practiceRuns: number
}

/** 稽核橋接的回應。result 由各探針自行定義,這裡用泛型帶過去。 */
export interface AuditForceResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
}

declare global {
  interface Window {
    __auditForce?: (name: string, arg?: unknown) => AuditForceResponse | Promise<AuditForceResponse> | null | undefined
  }
}

/**
 * 呼叫稽核橋接。橋接沒接上、探針沒註冊、回傳空值,三種情況都變成明確的失敗,
 * 而不是讓 spec 拿到 undefined 之後在很遠的地方爆一個看不懂的錯誤。
 */
export async function auditForce<T = unknown>(page: Page, name: string, arg?: unknown): Promise<AuditForceResponse<T>> {
  return page.evaluate(
    async ([n, a]) => {
      const bridge = window.__auditForce
      if (!bridge) return { ok: false, error: 'audit bridge missing' }
      const res = await bridge(n, a)
      return res ?? { ok: false, error: 'audit bridge returned nothing' }
    },
    [name, arg] as [string, unknown]
  ) as Promise<AuditForceResponse<T>>
}
