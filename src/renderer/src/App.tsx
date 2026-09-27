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

type PageId = 'dashboard' | 'scripts' | 'record' | 'practice' | 'calibration' | 'settings'

const NAV: Array<{ id: PageId; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '總覽', icon: LayoutDashboard },
  { id: 'scripts', label: '提詞講稿', icon: ScrollText },
  { id: 'record', label: '錄音轉錄', icon: AudioLines },
  { id: 'practice', label: '面試練習', icon: GraduationCap },
  { id: 'calibration', label: '個人化校準', icon: Ruler },
  { id: 'settings', label: '設定', icon: SettingsIcon }
]

function MainApp(): JSX.Element {
  const [page, setPage] = useState<PageId>(() => {
    const h = window.location.hash.replace('#/', '')
    const valid: PageId[] = ['dashboard', 'scripts', 'record', 'practice', 'calibration', 'settings']
    return (valid.includes(h as PageId) ? h : 'dashboard') as PageId
  })

  useEffect(() => {
    window.history.replaceState(null, '', `#/${page}`)
  }, [page])

  const render = (): JSX.Element => {
    switch (page) {
      case 'scripts':
        return <Scripts />
      case 'record':
        return <Record />
      case 'practice':
        return <Practice />
      case 'calibration':
        return <Calibration onDone={() => setPage('settings')} />
      case 'settings':
        return <SettingsPage onNavigate={setPage} />
      default:
        return <Dashboard onNavigate={setPage} />
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
              onClick={() => setPage(item.id)}
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
        <div className="border-t border-ink-800 px-5 py-3 text-[11px] text-ink-400">
          Ctrl+Alt+T 顯示 / 隱藏浮層
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{render()}</main>
    </div>
  )
}

export default function App(): JSX.Element {
  const [isOverlay] = useState(() => window.location.hash.startsWith('#/overlay'))

  useEffect(() => {
    if (!isOverlay) {
      useSettings.getState().load()
    }
  }, [isOverlay])

  return isOverlay ? <OverlayApp /> : <MainApp />
}
