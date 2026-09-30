import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * useEscape 的分層契約。
 *
 * 這個專案是 `environment: 'node'`,沒有 jsdom,所以這裡不假裝有 DOM:
 * Node 的 EventTarget 本來就實作了 DOM 規格裡的 `stopImmediatePropagation`
 * 語義(含 capture 選項),而 useEscape 的 effect 只碰 `window.addEventListener`。
 * 用 `vi.mock` 把 `useEffect` 換成一個確定性的 runner,就能驅動**真實的 hook 原始碼**,
 * 而不是把邏輯複製一份到測試裡(那樣測不到 bug)。
 */

/** 極簡的 useEffect runner:比對 deps、跑 effect、收 cleanup */
interface Cell {
  deps?: readonly unknown[]
  cleanup?: (() => void) | void
}
const cells: Cell[] = []
let cellIndex = 0

function resetHookRuntime(): void {
  cells.length = 0
  cellIndex = 0
}

/**
 * 一次 render pass。React 在每次 render 時都從第一個 hook cell 開始走,
 * 所以這裡必須先把 cellIndex 歸零 —— 漏了這個的話第二次呼叫會開新的 cell,
 * 「重新 render」會被誤測成「多掛了一個元件」。
 */
function renderPass(fn: () => void): void {
  cellIndex = 0
  fn()
}

function mockUseEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void {
  const cell = cells[cellIndex++] ?? (cells[cellIndex - 1] = {} as Cell)
  const same =
    cell.deps !== undefined &&
    deps !== undefined &&
    cell.deps.length === deps.length &&
    cell.deps.every((d, i) => Object.is(d, deps[i]))
  if (same) return
  if (typeof cell.cleanup === 'function') cell.cleanup()
  cell.deps = deps
  cell.cleanup = fn()
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: mockUseEffect }
})

const { useEscape } = await import('../useEscape')

/**
 * 符合 DOM 語義的 window 替身。
 *
 * 兩件事要自己補:
 *   1. `stopImmediatePropagation` 只擋**後面**註冊的 listener —— Node 的 EventTarget
 *      已經這樣做了,不需要我們做什么。
 *   2. 第三個參數是 boolean 時要展開成 `{ capture }`。WebIDL 規定 add/removeEventListener
 *      都有 `(type, listener, boolean useCapture)` 這個 overload,瀏覽器會展開;
 *      Node 的 EventTarget 只在物件形式下認得 capture,直接傳 `true` 會讓
 *      removeEventListener 抓不到剛才 add 的那個 listener。useEscape 傳的是 boolean
 *      `true`,所以這裡不補的話「卸載後不再回應」會是假失敗。
 */
class FakeWindow extends EventTarget {
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean
  ): void {
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
  }
}

let fakeWindow: FakeWindow
const originalWindow = (globalThis as { window?: unknown }).window

beforeEach(() => {
  resetHookRuntime()
  fakeWindow = new FakeWindow()
  ;(globalThis as { window?: unknown }).window = fakeWindow
})

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

function pressEscape(): void {
  const e = new Event('keydown', { bubbles: true, cancelable: true }) as Event & { key?: string }
  e.key = 'Escape'
  fakeWindow.dispatchEvent(e)
}

describe('useEscape', () => {
  it('Escape 會觸發;其他鍵不會', () => {
    const onEscape = vi.fn()
    renderPass(() => useEscape(onEscape))
    fakeWindow.dispatchEvent(new Event('keydown'))
    expect(onEscape).not.toHaveBeenCalled()
    pressEscape()
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('active=false 時完全不註冊(面板/對話框沒開時不吃 Esc)', () => {
    const onEscape = vi.fn()
    renderPass(() => useEscape(onEscape, false))
    pressEscape()
    expect(onEscape).not.toHaveBeenCalled()
  })

  /**
   * 本次修的就是這一條。
   *
   * 症狀:除錯面板開著時按 Esc 取消「刪除講稿」,對話框關掉的同時面板也跟著消失。
   * 原因:原本用 `stopPropagation()`,而它只阻止事件往「其他節點」傳播,
   * 對**同一個 target**(這裡是 window)上已註冊的其他 listener 毫無作用。
   */
  it('同時掛兩層時,只有先註冊的那層吃到 Esc', () => {
    const top = vi.fn()
    const bottom = vi.fn()
    renderPass(() => {
      useEscape(top) // 先註冊 = 上層(ConfirmHost 在 App.tsx 排在 DebugRoot 之前)
      useEscape(bottom)
    })
    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(bottom).not.toHaveBeenCalled()
  })

  it('三層也只會有一層回應(不會「每按一次 Esc 就多關掉一樣東西」)', () => {
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    renderPass(() => {
      useEscape(a)
      useEscape(b)
      useEscape(c)
    })
    pressEscape()
    expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 0, 0])
  })

  it('平台語義釘住:同一 target 上的 stopPropagation 擋不住別的 listener', () => {
    // 這條是上面那條測試的地基。如果哪天換成 jsdom / 瀏覽器,這個斷言仍然
    // 必須成立 —— 它是 DOM 規格,不是 Node 的實作細節。
    const first = vi.fn()
    const second = vi.fn()
    fakeWindow.addEventListener('keydown', (e) => {
      ;(e as Event).stopPropagation()
      first()
    })
    fakeWindow.addEventListener('keydown', second)
    pressEscape()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1) // ← 這就是原本的 bug
  })

  it('重新 render 成 active=false 就不再回應(取消註冊不能漏,否則 Esc 會打到已隱藏的面板)', () => {
    const onEscape = vi.fn()
    renderPass(() => useEscape(onEscape))
    renderPass(() => useEscape(onEscape, false))
    pressEscape()
    expect(onEscape).not.toHaveBeenCalled()
  })
})
