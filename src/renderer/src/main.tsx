import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { initAuditBridge, installToastBridge } from './lib/auditBridge'
import { toast } from './lib/toast'
import { installCloseGuard } from './lib/closeGuard'
import '@fontsource-variable/noto-sans-tc'
import './styles/global.css'

// 產品化:renderer 全域錯誤落盤到 main 日誌(公開發佈後唯一的問題回饋來源)。
// window.api 在 e2e/瀏覽器直開時可能不存在,全部防護。
function reportError(kind: string, message: string, stack?: string): void {
  try {
    window.api?.logFromRenderer?.('ERROR', `${kind}: ${message}\n${stack ?? ''}`)
  } catch {
    /* 連日誌都不可得時無能為力 */
  }
}

window.addEventListener('error', (e) => reportError('window.error', e.message, e.error?.stack))
window.addEventListener('unhandledrejection', (e) =>
  reportError('unhandledRejection', e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack}` : String(e.reason))
)

// 稽核模式(AI_TP_AUDIT=1,見 src/main/debug.ts)才掛狀態強制橋。
// 放在這裡而不是某個元件裡:兩個視窗都需要它,而且它與 React 的生命週期無關。
initAuditBridge()

// toast 橋只掛在 audit 模式(與 __auditForce 同一個開關),正式安裝包不會有。
void window.api
  ?.appInfo()
  ?.then((info) => {
    if (info?.audit) installToastBridge((kind, message) => toast[kind](message))
  })
  .catch(() => undefined)

// 關閉視窗守衛:main 擋下 close 之後由此顯示 App 內的確認對話框。
// 同樣放在這裡而不是元件裡:它與 React 生命週期無關,且必須比任何元件更早存在。
installCloseGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
