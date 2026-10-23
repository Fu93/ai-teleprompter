/**
 * mediapipe-wasm.test.mjs — wasm 同步腳本的行為。
 *
 * 最重要的是「來源不存在要失敗」:一個什麼都不做就回傳成功的同步腳本,
 * 會讓 app 在使用者第一次打開貼鏡模式時才因為缺 wasm 而壞掉。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncMediapipeWasm } from '../mediapipe-wasm.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-wasm-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true })
})

function fakePackage() {
  const from = join(tempDir(), 'wasm')
  mkdirSync(from)
  writeFileSync(join(from, 'vision_wasm_internal.js'), 'loader')
  writeFileSync(join(from, 'vision_wasm_internal.wasm'), Buffer.from([0, 97, 115, 109]))
  writeFileSync(join(from, 'README.md'), 'not shipped')
  return from
}

describe('syncMediapipeWasm', () => {
  it('只複製 loader 與 wasm,內容逐位元相同', () => {
    const from = fakePackage()
    const to = join(tempDir(), 'public', 'mediapipe', 'wasm')
    const result = syncMediapipeWasm({ from, to })
    expect(result.copied).toEqual(['vision_wasm_internal.js', 'vision_wasm_internal.wasm'])
    expect(readFileSync(join(to, 'vision_wasm_internal.wasm'))).toEqual(readFileSync(join(from, 'vision_wasm_internal.wasm')))
    expect(existsSync(join(to, 'README.md'))).toBe(false)
  })

  it('第二次執行不重寫相同的檔案', () => {
    const from = fakePackage()
    const to = tempDir()
    syncMediapipeWasm({ from, to })
    const before = statSync(join(to, 'vision_wasm_internal.wasm')).mtimeMs
    const again = syncMediapipeWasm({ from, to })
    expect(again.copied).toEqual([])
    expect(again.unchanged).toHaveLength(2)
    expect(statSync(join(to, 'vision_wasm_internal.wasm')).mtimeMs).toBe(before)
  })

  it('套件升版後會覆蓋舊的 wasm(loader 與 wasm 不可不同版)', () => {
    const from = fakePackage()
    const to = tempDir()
    syncMediapipeWasm({ from, to })
    writeFileSync(join(from, 'vision_wasm_internal.wasm'), Buffer.from([0, 97, 115, 109, 2]))
    expect(syncMediapipeWasm({ from, to }).copied).toEqual(['vision_wasm_internal.wasm'])
  })

  it('來源目錄不存在時大聲失敗,而不是靜默略過', () => {
    expect(() => syncMediapipeWasm({ from: join(tempDir(), 'missing'), to: tempDir() })).toThrow(/npm install/)
  })

  it('來源目錄沒有任何 wasm 時失敗', () => {
    const from = tempDir()
    writeFileSync(join(from, 'README.md'), 'x')
    expect(() => syncMediapipeWasm({ from, to: tempDir() })).toThrow(/空的/)
  })

  it('真正安裝的套件裡有 app 需要的三組 wasm', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const pkg = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
    for (const variant of ['vision_wasm_internal', 'vision_wasm_module_internal', 'vision_wasm_nosimd_internal']) {
      expect(existsSync(join(pkg, `${variant}.js`)), variant).toBe(true)
      expect(existsSync(join(pkg, `${variant}.wasm`)), variant).toBe(true)
    }
  })
})
