import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
