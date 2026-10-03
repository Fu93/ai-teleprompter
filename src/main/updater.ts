import { app, BrowserWindow } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { APP_UPDATE_DOWNLOADED } from '@shared/types'
import { state } from './state'

/**
 * updater.ts — 公開發佈基礎:自動更新(electron-updater + GitHub Releases)
 *
 * 打 tag push 後 CI 產出安裝包 + latest.yml → 使用者端啟動 30 秒後靜默檢查,
 * 下載完成以浮層廣播提示重啟(不打斷使用中的提詞)。
 * dev 環境(isPackaged=false)自動跳過——electron-updater 在未打包環境會拋錯。
 *
 * electron-updater 以動態 import + try/catch 載入:若打包配置出錯(asar 內缺
 * node_modules),載入失敗只損失自動更新,不能讓 main 在 import 階段整顆炸死
 * (實際踩過:靜態 import 缺模組時,main 連 initState/initLogging 都執行不到,
 *  打包版零視窗、零日誌、零 userData 寫入,完全無法診斷)。
 */
const CHECK_DELAY_MS = 30_000

/** typeof import 的型別;實際 interop 形狀由 Node 對 CJS 包的動態 import 決定 */
type UpdaterModule = typeof import('electron-updater')

function log(level: 'ERROR' | 'WARN', message: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'logs', 'main.log'),
      `[${new Date().toISOString()}] [${level}] ${message}\n`,
      'utf-8'
    )
  } catch {
    /* 日誌不可寫時靜默:updater 不應因日誌失敗而中斷 */
  }
}

export function initUpdater(): void {
  if (!app.isPackaged) return

  void import('electron-updater')
    .then((mod) => {
      // electron-updater 是 CJS 包:Node 原生 import() 的命名導出未必被
      // cjs-module-lexer 認出(實測 autoUpdater 為 undefined),實體在
      // default(= module.exports)上;兩種形狀都相容,取不到就報錯落日誌
      const ns = (mod as unknown as { default?: UpdaterModule }).default ?? mod
      const autoUpdater = (ns as Partial<UpdaterModule>).autoUpdater
      if (!autoUpdater) throw new Error('electron-updater 未導出 autoUpdater(ESM interop 失敗)')

      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true

      autoUpdater.on('update-downloaded', (info) => {
        // 先存起來,再廣播。順序不能反:
        //   廣播是一次性事件,而 renderer 的訂閱是在掛載時才建的。下載完成的
        //   瞬間往往沒有任何一個訂閱者(更新預設在啟動 30 秒後下載完,那時
        //   使用者多半在總覽頁),只廣播的話那個提示永遠不會出現,而
        //   autoInstallOnAppQuit 會在下次退出時默默換版本 —— 正是
        //   設定頁橫幅的註解要避免的那件事。
        state.updateInfo = {
          version: info.version,
          releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 2000) : ''
        }
        const payload = state.updateInfo
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(APP_UPDATE_DOWNLOADED, payload)
        }
      })

      autoUpdater.on('error', (err) => {
        // 更新失敗(斷網/404)對使用者無意義,靜默;下次啟動再試
        log('WARN', `checkForUpdates 失敗: ${err instanceof Error ? err.message : String(err)}`)
      })

      setTimeout(() => {
        void autoUpdater.checkForUpdatesAndNotify().catch(() => undefined)
      }, CHECK_DELAY_MS)
    })
    .catch((err) => {
      // 載入/初始化失敗:只損失自動更新,不擋啟動;落日誌供診斷
      log('ERROR', `electron-updater 初始化失敗: ${err instanceof Error ? err.stack : String(err)}`)
    })
}
