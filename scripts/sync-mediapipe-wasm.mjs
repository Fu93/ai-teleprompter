/**
 * 把 MediaPipe 的 wasm 從 node_modules 同步到 src/renderer/public/mediapipe/wasm/。
 * 理由與時機見 scripts/lib/mediapipe-wasm.mjs。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncMediapipeWasm } from './lib/mediapipe-wasm.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { copied, unchanged } = syncMediapipeWasm({
  from: join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  to: join(root, 'src', 'renderer', 'public', 'mediapipe', 'wasm')
})
if (copied.length > 0) {
  console.log(`MediaPipe wasm:已同步 ${copied.length} 個檔案(${unchanged.length} 個未變)`)
}
