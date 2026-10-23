/**
 * mediapipe-wasm.mjs — 把 @mediapipe/tasks-vision 的 wasm 從 node_modules 同步到 renderer 的 public 目錄。
 *
 * ## 為什麼不再把 wasm 放進 git
 *
 * 之前 src/renderer/public/mediapipe/wasm/ 直接 commit 了三組 loader + wasm(約 34MB),
 * 而它們與 node_modules/@mediapipe/tasks-vision/wasm/ 裡的檔案逐位元相同。
 * 這有兩個代價:
 *
 * 1. 每次 clone 都要下載這 34MB,而且歷史裡每換一次版本就再多一份。
 * 2. 版本漂移:package.json 寫的是 `^1.0.1`。套件一升版,`FilesetResolver`(來自 npm)
 *    就會去載入 commit 在 repo 裡的舊 wasm —— loader 與 wasm 不同版本,錯誤只會在執行期出現。
 *
 * 從 node_modules 複製,loader 與 wasm 永遠出自同一個套件版本。
 *
 * ## 什麼時候跑
 *
 * postinstall(`npm ci` / `npm install`),另外 predev / prebuild / predist 再保險一次,
 * 給用 `--ignore-scripts` 安裝的人。內容相同的檔案不會重寫,所以重複執行幾乎不花時間。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 只同步 loader 與 wasm 本體;套件目錄裡若多出別的檔案,不帶進 public。 */
const SYNCED = /\.(js|wasm)$/

/**
 * @param {{ from: string, to: string }} dirs
 * @returns {{ copied: string[], unchanged: string[] }}
 */
export function syncMediapipeWasm({ from, to }) {
  // 來源不存在時必須大聲失敗:靜默略過會讓 app 在執行期才因為找不到 wasm 而壞掉,
  // 那比安裝時的一行錯誤難查得多。
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new Error(`找不到 MediaPipe wasm 來源目錄:${from}(先執行 npm install)`)
  }
  const names = readdirSync(from).filter((name) => SYNCED.test(name)).sort()
  if (names.length === 0) {
    throw new Error(`MediaPipe wasm 來源目錄是空的:${from}`)
  }
  mkdirSync(to, { recursive: true })
  const copied = []
  const unchanged = []
  for (const name of names) {
    const src = join(from, name)
    const dest = join(to, name)
    if (existsSync(dest) && sameBytes(src, dest)) {
      unchanged.push(name)
      continue
    }
    copyFileSync(src, dest)
    copied.push(name)
  }
  return { copied, unchanged }
}

function sameBytes(a, b) {
  if (statSync(a).size !== statSync(b).size) return false
  return readFileSync(a).equals(readFileSync(b))
}
