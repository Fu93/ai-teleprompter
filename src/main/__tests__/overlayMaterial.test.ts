/**
 * overlayMaterial.test.ts — 浮層視窗的**視窗層**表面:底色,以及不該被碰的系統材質。
 *
 * 為什麼這幾條要存在(都是實機量到的缺陷,不是保險):
 *   浮層頁面只在**面板形狀內**畫東西,面板的四個圓角外是透明的 —— 那一層
 *   頁面截圖看不到(所有 audit:* 都是對 page 截圖),卻決定了四個角長什麼樣。
 *   1. BrowserWindow 的 backgroundColor 預設是 **#FFF**:四個角的三角形露出
 *      白底(246,245,244,…),而同一塊桌面沒有視窗時是 43,43,43,…。
 *      使用者看到的就是「四個白色的方角」。選項單獨不生效 —— 建立後要顯式設。
 *   2. setBackgroundMaterial 的材質畫在**視窗矩形**上(展開形態下切換它會改變
 *      視窗矩形 95.4% 的像素、平均 165 級),而且它會把底色重設回白色
 *      (實測:底色透明 → 37=桌面;再呼叫 setBackgroundMaterial('none')
 *       → 232=白、getBackgroundColor 回 #FFFFFF)。所以 App 完全不碰它。
 *   完整數字與推論寫在 windows.ts 的 createOverlayWindow。
 *
 * 為什麼驗行為而不是驗原始碼字串:
 *   問的是實際原生呼叫與實際傳給 Electron 的選項。字串檢查會在改名/搬函式時
 *   安靜地變成假綠。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'

/** 會鋪滿整個視窗矩形、因而會露在面板圓角外的系統材質。 */
const MATERIALS_THAT_PAINT_THE_RECTANGLE = ['acrylic', 'mica', 'tabbed']

beforeEach(() => {
  vi.resetModules()
})

/** createOverlayWindow 會用到的一整套視窗 API;選項與呼叫都留下來斷言。 */
function makeStub() {
  const created: Array<Record<string, unknown>> = []
  const backgroundColors: string[] = []
  const materialCalls: string[] = []
  class StubWindow {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    on = vi.fn()
    once = vi.fn()
    isDestroyed = () => false
    setAlwaysOnTop = vi.fn()
    setContentProtection = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setBackgroundMaterial = (material: string) => {
      materialCalls.push(material)
    }
    setBackgroundColor = (color: string) => {
      backgroundColors.push(color)
    }
    setMinimumSize = vi.fn()
    getSize = () => [720, 260]
    setSize = vi.fn()
    isResizable = () => true
    setResizable = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()
    constructor(options: Record<string, unknown>) {
      created.push(options)
    }
  }
  return { StubWindow, created, backgroundColors, materialCalls }
}

/** 用 stub 建立浮層視窗,回傳 stub 與 state。 */
async function createOverlay(stub: ReturnType<typeof makeStub>) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      isPackaged: false,
      getPath: vi.fn(() => '/tmp'),
      getVersion: () => '0.2.0-test',
      quit: vi.fn()
    },
    BrowserWindow: stub.StubWindow,
    dialog: { showMessageBox: vi.fn() },
    screen: {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } })
    },
    shell: {}
  }))
  const windows = await import('../windows')
  const state = await import('../state').then((m) => m.state)
  state.settings = structuredClone(DEFAULT_SETTINGS)
  windows.createOverlayWindow()
  return { windows, state }
}

describe('浮層視窗的底色', () => {
  it('底色必須是透明:#FFF 的白底會從面板圓角外露出來(240 vs 桌面 40)', async () => {
    const stub = makeStub()
    await createOverlay(stub)
    expect(stub.created, 'createOverlayWindow 沒有建立視窗').toHaveLength(1)
    expect(stub.created[0]['transparent'], '浮層必須是透明視窗').toBe(true)
    expect(stub.created[0]['backgroundColor'], '選項要表達意圖:透明底色').toBe('#00000000')
    expect(
      stub.backgroundColors,
      '選項在這個 Electron 版本不生效(實測建立後 getBackgroundColor 仍是 #FFFFFF、角是白補丁),' +
        '所以建立後必須顯式呼叫 setBackgroundColor'
    ).toContain('#00000000')
  })

  it('底色只設一次,而且設定寫入不會再動它', async () => {
    const stub = makeStub()
    const { windows, state } = await createOverlay(stub)
    expect(stub.backgroundColors).toEqual(['#00000000'])
    windows.applyOverlayWindowSettings()
    windows.applyOverlayWindowSettings()
    expect(stub.backgroundColors, '設定寫入(滑桿每 tick 一次)不該再改底色').toEqual(['#00000000'])
    // 設定寫入之後 state.overlayWindow 仍是同一顆 stub
    expect(state.overlayWindow).toBeTruthy()
  })

  it('App 完全不碰系統材質:它鋪滿視窗矩形,而且會把底色重設回白色', async () => {
    const stub = makeStub()
    const { windows, state } = await createOverlay(stub)
    // 建立 + 兩次設定寫入 + 一次 morph 的即時尺寸同步路徑
    windows.applyOverlayWindowSettings()
    windows.applyOverlayWindowSettings()
    expect(stub.materialCalls, 'App 不該呼叫 setBackgroundMaterial').toEqual([])
    for (const m of MATERIALS_THAT_PAINT_THE_RECTANGLE) {
      expect(stub.materialCalls).not.toContain(m)
    }
    expect(stub.backgroundColors, '底色仍然是透明的那一次').toEqual(['#00000000'])
    expect(state.overlayWindow).toBeTruthy()
  })
})

/**
 * 這條是**金絲雀**,不是行為驗證:真正擋缺陷的是上一組「App 完全不碰系統材質」。
 * 留它下來的理由是「這個函式不該回來」本身有資訊(它會把底色重設回白色),
 * 而且它的失效模式是「有人把函式加回來但沒有在任何被測路徑上呼叫」—— 那種
 * 情況下行為測試確實看不到,只有這條會紅。
 */
describe('浮層視窗的模組介面(金絲雀)', () => {
  it('windows.ts 不再輸出 syncOverlayMaterial(材質的形態閘已移除)', async () => {
    vi.resetModules()
    const stub = makeStub()
    vi.doMock('electron', () => ({
      app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: () => '0.2.0-test', quit: vi.fn() },
      BrowserWindow: stub.StubWindow,
      dialog: { showMessageBox: vi.fn() },
      screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
      shell: {}
    }))
    const windows = await import('../windows')
    expect(
      'syncOverlayMaterial' in windows,
      'syncOverlayMaterial 會呼叫 setBackgroundMaterial,而它會把底色重設回白色'
    ).toBe(false)
  })
})
