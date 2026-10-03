import { net, protocol } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { logMain } from './logging'

/**
 * appProtocol.ts — 把打包後 renderer 目錄裡的「媒體管線資源」掛成可 fetch 的來源。
 *
 * 為什麼需要:mediapipe 的 wasm 與模型以相對路徑 fetch(faceLandmarker.ts),
 * dev 走 http:// 沒問題;打包版頁面以 file:// 載入,而 Chromium 拒絕 file: scheme
 * 的 fetch —— 個人化校準(虹膜量測)在安裝版直接失敗。dev 走 http 所以測得到,
 * 打包沒人驗過,稽核也全部跑在 dev 模式。
 *
 * 為什麼不把「頁面本身」改成 app:// 載入:IndexedDB(講稿/會議/練習)綁在
 * file:// origin 上,換載入 origin 會讓現有使用者的資料整批消失。所以這個
 * scheme 只服務 mediapipe/ 前綴的資源,頁面照舊 file:// 載入。
 *
 * privileges 逐項:supportFetchAPI 讓 fetch 能打這個 scheme;standard/secure 讓它
 * 有正常 origin 語意;stream 供 WebAssembly.instantiateStreaming;corsEnabled +
 * 回應上的 ACAO:* 允許 file://(null origin)跨源 fetch 到它。
 */
export const APP_ASSET_ORIGIN = 'app://bundle'

const RENDERER_DIR = join(__dirname, '../renderer')
/** 這個 scheme 只為 mediapipe 存在,不是通用檔案伺服器:前綴之外一律 404 */
const SERVABLE_PREFIX = 'mediapipe/'
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream'
}

/** 必須在 app ready 之前呼叫(registerSchemesAsPrivileged 的硬性要求) */
export function registerAppAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** 在 app ready 之後呼叫 */
export function registerAppAssetProtocol(): void {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const base = join(RENDERER_DIR, SERVABLE_PREFIX)
      const abs = join(RENDERER_DIR, rel)
      // host 與前綴雙重檢查:app://bundle/mediapipe/… 之外的請求一律 404
      if (url.host !== 'bundle' || !rel.startsWith(SERVABLE_PREFIX) || !abs.startsWith(base)) {
        return new Response('not found', { status: 404 })
      }
      const res = await net.fetch(pathToFileURL(abs).toString(), { bypassCustomProtocolHandlers: true })
      const type = MIME[abs.slice(abs.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'
      // net.fetch(file://) 的 Content-Type 由副檔名推得,不一定可靠(.task 沒有
      // 公認 MIME),在這裡統一覆寫;ACAO:* 讓 file:// 頁面的 fetch 能讀回應。
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }
      })
    } catch (err) {
      logMain('WARN', `app:// 資源載入失敗:${request.url}(${err instanceof Error ? err.message : String(err)})`)
      return new Response('not found', { status: 404 })
    }
  })
}
