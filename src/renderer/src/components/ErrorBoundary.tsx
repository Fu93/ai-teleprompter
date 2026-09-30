/**
 * ErrorBoundary.tsx — renderer 渲染期例外時的復原畫面。
 *
 * 為什麼需要(不是「防禦性程式碼」,是產品化的最低要求):
 *   React 在渲染期丟錯會把整棵樹 unmount,結果是**一片白畫面**:沒有訊息、
 *   沒有重試、沒有留下任何線索。對一個明天要給人用的桌面 App,這是最殘酷的
 *   失敗模式 —— 使用者看到一片白,而開發者這邊什麼都查不到。
 *
 *   main.tsx 已經有 window.onerror / unhandledrejection 落盤,所以「錯誤有紀錄」
 *   早就有了。缺的是兩件事,這裡各補一件:
 *     1. 復原畫面:讓使用者看得懂、做得完(重新載入 / 複製錯誤 / 開記錄)。
 *     2. componentStack:window.onerror 只拿得到 JS stack,拿不到「哪個元件拋的」。
 *        而那正是「這是設定頁的哪一顆滑桿」的唯一來源 —— 只有 React 邊界有。
 *
 * 位置為什麼在 <App /> 外層、而且在 StrictMode **外面**:
 *   - 在 App 外層:App 內的 ToastHost / ConfirmHost 都隨崩潰一起消失,所以復原
 *     畫面不能依賴它們 —— 它必須自帶對話框行為(這裡用的是行內展開,不是 modal)。
 *   - 在 StrictMode 外:StrictMode 會在開發時把邊界重掛一次,狀態與 componentDidCatch
 *     的時序會走樣;而這個邊界的存在本身就是「出錯時怎麼辦」,不需要被 dev 模式演一次。
 *
 * 「你會失去什麼」是量出來的,不是猜的:
 *   崩潰當下 `peekCloseBlocker()` 還讀得到 App 手上有什麼(正在錄音 / 講稿沒存),
 *   所以必須在 componentDidCatch 裡**同步**取快照存進 state。
 *   為什麼不能事後去問:崩潰時 useCloseGuard 的 effect cleanup 會跟著跑,而
 *   cleanup 的動作正是把它清成 null —— 實測走 IPC 讀回來必定是空的(見
 *   closeGuard.peekCloseBlocker 的註解)。講不出具體內容時才退回通用話術,
 *   而那句通用話術必須誠實:內容「可能」不見,不能說「沒有」不見。
 */
import type { ErrorInfo, JSX, ReactNode } from 'react'
import { Component, useEffect, useState } from 'react'
import { create } from 'zustand'
import { AlertOctagon, Check, Copy, ExternalLink, RotateCcw } from 'lucide-react'
import { peekCloseBlocker } from '../lib/closeGuard'

interface CrashInfo {
  message: string
  stack: string
  componentStack: string
  /** 崩潰當下 App 手上還握著的東西;null = 當時確實沒有 */
  atRisk: string | null
}

interface Props {
  children: ReactNode
  /** 供測試辨識:不要依賴文案(文案會改) */
  testId?: string
}

interface State {
  crash: CrashInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { crash: null }

  static getDerivedStateFromError(): State {
    return { crash: { message: '', stack: '', componentStack: '', atRisk: null } }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // 這裡的 componentStack 是 React 給的「元件樹位置」,window.onerror 拿不到。
    // 它是「哪一顆按鈕/欄位弄壞的」的唯一來源,也是這整個邊界存在的理由。
    const componentStack = errorInfo?.componentStack ?? ''
    const message = error?.message ?? String(error)
    const stack = error?.stack ?? ''
    this.setState({
      crash: { message, stack, componentStack, atRisk: peekCloseBlocker() }
    })

    // 先落盤,再談畫面。logFromRenderer 是 ipcRenderer.invoke(不 await),
    // renderer 若隨後被重載,這則錯誤仍然已經送到 main。
    void window.api?.logFromRenderer?.(
      'ERROR',
      `ErrorBoundary:${message}\n--- stack ---\n${stack}\n--- componentStack ---\n${componentStack}`
    )
  }

  override render(): ReactNode {
    const { crash } = this.state
    if (!crash) return this.props.children
    return <CrashScreen crash={crash} testId={this.props.testId} onReload={() => this.reload()} />
  }

  private reload(): void {
    // 整棵樹(含 React 狀態)必須真的重來一次,setState 救不了已經壞掉的元件樹
    window.location.reload()
  }
}

/** 復原畫面。獨立元件,好讓它自己管「行內確認重新載入」的狀態。 */
function CrashScreen({ crash, testId, onReload }: { crash: CrashInfo; testId?: string; onReload: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)

  // atRisk 已經在 componentDidCatch 裡同步取好了(見檔頭),這裡不重新去查。
  const lost = !!crash.atRisk

  const details = [
    `訊息：${crash.message}`,
    '',
    '--- JS stack ---',
    crash.stack,
    '',
    '--- componentStack（哪個元件拋的）---',
    crash.componentStack.trim() || '(React 未提供)',
    '',
    `--- 崩潰時 App 手上還握著的東西 ---\n${crash.atRisk ?? '(無)'}`,
    '',
    '--- 記錄檔 ---',
    '開啟「記錄資料夾」後把 main.log 附在回報裡最有幫助。'
  ].join('\n')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪貼簿不可得(權限/無 clipboard 權限)時不假裝成功:
      // 畫面上仍留著「開啟記錄資料夾」這個一定可行的出口。
      setCopied(false)
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[#0b0d13] p-6" data-testid={testId ?? 'crash-screen'}>
      <div className="glass w-full max-w-[520px] rounded-2xl border border-white/12 p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-450/15">
            <AlertOctagon size={18} className="text-rose-450" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold text-ink-100">畫面出了問題</h1>
            {/* 誠實優先：不能確認就說不能確認，不能用「沒有東西會遺失」來讓人放心。 */}
            {lost ? (
              <p className="mt-2 rounded-lg border border-rose-450/30 bg-rose-450/10 px-3 py-2 text-xs leading-relaxed text-ink-100">
                重新載入會失去：<span className="font-semibold">{crash.atRisk}</span>
                <span className="mt-1 block text-ink-300">
                  這是程式在崩潰當下自己記錄的，不是猜的。已存進資料庫的內容不受影響。
                </span>
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-ink-300">
                程式記錄的「未存內容」是空的——已存進資料庫的內容不會受影響。
                <span className="mt-1 block text-ink-400">
                  但畫面當下正在編輯、還沒存的东西會消失。
                </span>
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
              錯誤已經寫進記錄檔。把「複製錯誤詳細資料」貼給我，回報會快很多。
            </p>
          </div>
        </div>

        {confirming && (
          <div
            role="alertdialog"
            aria-label="確認重新載入"
            className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2.5"
          >
            <div className="text-xs leading-relaxed text-ink-100">確定要重新載入嗎？畫面上還沒存的內容會沒有了。</div>
            <div className="mt-2.5 flex justify-end gap-2">
              <button className="btn-outline text-xs" onClick={() => setConfirming(false)}>
                先不要
              </button>
              <button className="btn-danger text-xs" onClick={onReload}>
                還是重新載入
              </button>
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="btn-outline text-xs" onClick={() => void copy()}>
            {copied ? <Check size={13} className="mr-1.5 text-emerald-400" /> : <Copy size={13} className="mr-1.5" />}
            {copied ? '已複製' : '複製錯誤詳細資料'}
          </button>
          <button
            className="btn-outline text-xs"
            onClick={() => void window.api?.openLogDir?.()}
            title="開啟記錄資料夾,裡面有 main.log"
          >
            <ExternalLink size={13} className="mr-1.5" />
            開啟記錄資料夾
          </button>
          <button
            className="btn-primary text-xs"
            onClick={() => (lost ? setConfirming(true) : onReload())}
            data-crash="reload"
          >
            <RotateCcw size={13} className="mr-1.5" />
            重新載入
          </button>
        </div>
      </div>
    </div>
  )
}

// ===== audit-only:讓 e2e / 稽核能真的觸發一次渲染期例外 =====
// 為什麼可以無條件存在:註冊進 auditBridge 的 registry 之後,唯一的呼叫路徑是
// window.__auditForce,而那條路徑只在 appInfo().audit 為 true 時才掛(見
// src/main/debug.ts 的 AUDIT)。打包版裡這個 Map 條目不可達 —— 與 auditBridge
// 檔頭寫的「註冊本身沒有成本,不必在元件裡散落條件判斷」是同一個理由。
// 反過來說:沒有這個探針,「崩潰時畫面長什麼樣」就只能靠推理,永遠量不到。
const useCrashProbe = create<{ boom: boolean }>(() => ({ boom: false }))

export function setCrashProbe(boom: boolean): void {
  useCrashProbe.setState({ boom })
}

export function CrashProbe(): JSX.Element | null {
  if (useCrashProbe((s) => s.boom)) {
    throw new Error('audit: 故意丟出的渲染期錯誤（用來驗證崩潰復原畫面）')
  }
  return null
}
