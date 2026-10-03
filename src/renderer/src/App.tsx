import type { JSX } from "react"
import { useEffect, useRef, useState } from 'react'
import {
  AudioLines,
  GraduationCap,
  LayoutDashboard,
  Ruler,
  ScrollText,
  Settings as SettingsIcon
} from 'lucide-react'
import { cn } from './lib/utils'
import { useSettings } from './lib/store'
import Dashboard from './pages/Dashboard'
import Scripts from './pages/Scripts'
import Record from './pages/Record'
import Practice from './pages/Practice'
import SettingsPage from './pages/SettingsPage'
import Calibration from './pages/Calibration'
import OverlayApp from './overlay/OverlayApp'
import { ToastHost } from './components/ToastHost'
import { DebugRoot } from './components/DebugPanel'
import { ConfirmHost } from './components/ConfirmDialog'
import { useDebug } from './lib/debug'
import { registerAuditControl } from './lib/auditBridge'
import { confirmDialog } from './lib/confirm'
import { registerNavigator } from './lib/nav'

type PageId = 'dashboard' | 'scripts' | 'record' | 'practice' | 'calibration' | 'settings'

const NAV: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '總覽', icon: LayoutDashboard },
  { id: 'scripts', label: '提詞講稿', icon: ScrollText },
  { id: 'record', label: '錄音轉錄', icon: AudioLines },
  { id: 'practice', label: '面試練習', icon: GraduationCap },
  { id: 'calibration', label: '個人化校準', icon: Ruler },
  { id: 'settings', label: '設定', icon: SettingsIcon }
]

/** 側欄熱鍵提示:跟隨設定動態顯示(自訂熱鍵後文案不再過期) */
function SidebarHotkeyHint(): JSX.Element {
  const toggleKey = useSettings((s) => s.settings?.hotkeys.toggleOverlay)
  const load = useSettings((s) => s.load)
  const loaded = useSettings((s) => s.loaded)
  // 除錯層由其 root 向 main 問 appInfo().debug 後設起來,這裡只讀結果
  const debugReady = useDebug((s) => s.enabled)
  // settings 尚未載入時補一次 load(防外部清除 store);正常啟動流程已載
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  return (
    <div className="space-y-2 border-t border-ink-800 px-5 py-3 text-[11px] text-ink-400">
      <div>
        {toggleKey ? `${toggleKey.replaceAll('Control', 'Ctrl')} 顯示 / 隱藏浮層` : '熱鍵未設定:到設定頁設定'}
      </div>
      {/* 除錯面板的入口:快捷鍵是 Ctrl+Shift+D,但沒必要讓人先記住它 */}
      {debugReady && (
        <button
          onClick={() => useDebug.getState().togglePanel()}
          className="w-full cursor-pointer rounded-md border border-accent-400/40 bg-accent-500/15 px-2 py-1 text-[10px] text-accent-300 transition-colors hover:bg-accent-500/25"
        >
          除錯面板 · Ctrl+Shift+D
        </button>
      )}
    </div>
  )
}

function MainApp(): JSX.Element {
  const [page, setPage] = useState<PageId>(() => {
    const h = window.location.hash.replace('#/', '')
    const valid: PageId[] = ['dashboard', 'scripts', 'record', 'practice', 'calibration', 'settings']
    return (valid.includes(h as PageId) ? h : 'dashboard') as PageId
  })
  // 講稿編輯中有未存變更:側欄切頁前要攔下來確認
  const [scriptsDirty, setScriptsDirty] = useState(false)
  // 錄音/練習進行中:頁面主動上報的離開守衛訊息(與 scriptsDirty 同一模式,
  // 但訊息由頁面給 —— 「正在錄音」與「練習進行中」要講的話不同)。
  // 沒有它,錄音中點側欄會把整場會議靜默丟掉:頁面 unmount 只收音源不寫 DB。
  const [leaveGuard, setLeaveGuard] = useState<string | null>(null)

  const navigate = async (target: PageId): Promise<void> => {
    // 同頁點擊(使用者常反射性點側欄當前項)必須直接返回:下面的確認與
    // setScriptsDirty(false) 都是「離開」的語意,對當前頁執行會把 dirty 旗標
    // 靜默解除 —— 之後真正切頁時守衛已不在,未存變更就會無聲消失。
    if (target === page) return
    if (
      scriptsDirty &&
      !(await confirmDialog({
        title: '講稿有未儲存的修改',
        body: '離開「提詞講稿」會遺失這些變更。',
        confirmLabel: '放棄變更並離開'
      }))
    ) {
      return
    }
    if (
      leaveGuard &&
      !(await confirmDialog({
        title: '離開會遺失進行中的內容',
        body: leaveGuard,
        confirmLabel: '放棄並離開'
      }))
    ) {
      return
    }
    setScriptsDirty(false)
    setPage(target)
  }

  useEffect(() => {
    window.history.replaceState(null, '', `#/${page}`)
  }, [page])

  /**
   * 把 navigate 登錄給全域 toast(可行動錯誤的「前往設定」按鈕)。
   *
   * 為什麼需要這個橋而不是讓 toast 直接改 hash:hash 會**繞過下面那兩道
   * 守衛**。講稿有未存變更時按「前往設定」就會靜默丟掉內容 —— 而「導航到
   * 設定」正是錯誤提示最常建議的下一步,那會讓它變成一個常見的資料遺失觸發器。
   * 登錄的是 App 自己的 navigate,守衛與訊息都在同一處。
   *
   * ⚠️ 這裡**不能**直接把 navigate 放進依賴列,也不能只依賴 [page]。
   * navigate 每次 render 都是新的函式,會讀到當下的 scriptsDirty / leaveGuard。
   * 若只登錄一次(或只在 page 改變時重新登錄),登錄進去的是某一次 render 的
   * 快照 —— 使用者在講稿頁打了字(page 沒變)之後從 toast 按「前往設定」,
   * 拿到的是 scriptsDirty=false 的舊閉包,守衛直接失效,未存內容就這樣消失。
   * 這正是本檔存在的理由,不能由它自己引入。
   *
   * 正確做法是「永遠指向最新」的 ref:註冊一次,ref 每次 render 更新。
   */
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(
    () => registerNavigator((p) => void navigateRef.current(p)),
    []
  )

  /**
   * 稽核用:依頁面 id 導航。
   *
   * 離線稽核原本是在側欄上比對按鈕文字再 click,而「找不到元素」與
   * 「這一頁沒問題」在截圖與報告上無法區分。改成明確的 id 之後,
   * 找不到就回 false,呼叫端可以當場報 state-unreached。
   */
  useEffect(
    () =>
      registerAuditControl('app.navigate', (arg) => {
        const id = String(arg) as PageId
        const valid: PageId[] = ['dashboard', 'scripts', 'record', 'practice', 'calibration', 'settings']
        if (!valid.includes(id)) return false
        setPage(id)
        return true
      }),
    []
  )

  const render = (): JSX.Element => {
    switch (page) {
      case 'scripts':
        return <Scripts onDirtyChange={setScriptsDirty} />
      case 'record':
        return <Record onGuardChange={setLeaveGuard} />
      case 'practice':
        return <Practice onGuardChange={setLeaveGuard} />
      case 'calibration':
        return <Calibration onDone={() => setPage('settings')} />
      case 'settings':
        return <SettingsPage onNavigate={(p) => void navigate(p)} />
      default:
        return <Dashboard onNavigate={(p) => void navigate(p)} />
    }
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-600 text-white">
            <ScrollText size={17} />
          </div>
          <div>
            <div className="text-sm font-semibold">AI 提詞機</div>
            <div className="text-[10px] text-ink-400">Prompt · Transcribe · Coach</div>
          </div>
        </div>
        {/*
          data-effect-scope="nav":側栏是**跨頁面的同一個元件**。
          沒有這個屬性的話,同一顆「總覽」會在六個頁面上各被算成一顆控制項 ——
          效果稽核的覆蓋率會冒出 42 筆「沒登記」的假問題,而真正的缺口在裡面被洗掉。
        */}
        <nav data-effect-scope="nav" className="mt-2 flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => void navigate(item.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer',
                page === item.id
                  ? 'bg-ink-800 font-medium text-ink-100'
                  : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
              )}
            >
              <item.icon size={16} className={page === item.id ? 'text-accent-400' : ''} />
              {item.label}
            </button>
          ))}
        </nav>
        <SidebarHotkeyHint />
      </aside>
      <main className="flex-1 overflow-y-auto">{render()}</main>
      <ToastHost />
      <ConfirmHost />
      <DebugRoot />
    </div>
  )
}

export default function App(): JSX.Element {
  // dev 用 '#/overlay'、打包 loadFile hash 產生 '#overlay' — 兩種都要認
  const [isOverlay] = useState(() => /^#\/?overlay$/.test(window.location.hash))

  useEffect(() => {
    if (!isOverlay) {
      useSettings.getState().load()
    }
  }, [isOverlay])

  return isOverlay ? <OverlayApp /> : <MainApp />
}
