import type { JSX } from "react"
import { useEffect, useState } from 'react'
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
  // settings 尚未載入時補一次 load(防外部清除 store);正常啟動流程已載
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  return (
    <div className="border-t border-ink-800 px-5 py-3 text-[11px] text-ink-400">
      {toggleKey ? `${toggleKey.replaceAll('Control', 'Ctrl')} 顯示 / 隱藏浮層` : '熱鍵未設定:到設定頁設定'}
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

  const navigate = (target: PageId): void => {
    if (scriptsDirty && target !== page && !window.confirm('講稿有未儲存的修改，離開將遺失這些變更。確定要離開嗎？')) {
      return
    }
    setScriptsDirty(false)
    setPage(target)
  }

  useEffect(() => {
    window.history.replaceState(null, '', `#/${page}`)
  }, [page])

  const render = (): JSX.Element => {
    switch (page) {
      case 'scripts':
        return <Scripts onDirtyChange={setScriptsDirty} />
      case 'record':
        return <Record />
      case 'practice':
        return <Practice />
      case 'calibration':
        return <Calibration onDone={() => setPage('settings')} />
      case 'settings':
        return <SettingsPage onNavigate={navigate} />
      default:
        return <Dashboard onNavigate={navigate} />
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
        <nav className="mt-2 flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
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
