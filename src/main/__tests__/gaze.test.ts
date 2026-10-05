/**
 * gaze.test.ts — 貼鏡凝視錨點(DESIGN_RESEARCH P0-1)的決策邏輯。
 *
 * 為什麼這幾條要存在:
 *   錨點的每一條壞法都發生在**台上**:拔掉外接螢幕、改縮放、校正後換桌機。
 *   壞法只有兩種 —— ①把浮層停到錯的螢幕上(等於消失)②安靜地退回角落卻
 *   讓人以為「吸附壞了」。resolveGazeDock / gazeInfo 是三條 IPC 路徑
 *   (鎖定/停靠/狀態列)唯一的判斷來源,所以在這裡把每一條分支釘死。
 *
 * 顯示器用平面物件(DisplayLike)而不是 electron.Display:決策邏輯不該
 * 需要 mock 整個 electron 才能測 —— 那種測試最後都變成在測 mock。
 */
import { describe, expect, it } from 'vitest'
import { anchorOnDisplay, findAnchorDisplay, gazeInfo, resolveGazeDock } from '../gaze'
import { LENS_BAND_TOP_PX } from '@shared/overlayShapes'
import type { GazeAnchor } from '@shared/types'
import type { DisplayLike } from '../gaze'

const primary: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const external: DisplayLike = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }
const displays = [primary, external]

const anchor = (over: Partial<GazeAnchor> = {}): GazeAnchor => ({
  x: 640,
  y: 8,
  displayId: 1,
  cameraLabel: 'Integrated Camera',
  ...over
})

describe('resolveGazeDock 停靠決策', () => {
  it('未鎖定 → 退回角落,但**不算** stale(正常的第一天,不是要報警的狀態)', () => {
    expect(resolveGazeDock(null, displays)).toEqual({ action: 'fallback', stale: false })
  })

  it('有效錨點 → dock 到錨點座標', () => {
    expect(resolveGazeDock(anchor(), displays)).toEqual({ action: 'dock', x: 640, y: 8 })
  })

  it('錨點所在螢幕已拔掉 → 退回角落 + stale(設定頁要提示重新校正)', () => {
    expect(resolveGazeDock(anchor({ displayId: 99 }), displays)).toEqual({
      action: 'fallback',
      stale: true
    })
  })

  it('螢幕還在但座標已出界(改縮放/鏡射)→ 同樣 stale —— 差的螢幕不能停', () => {
    // id 對、位置跑到 1920×1080 的右下外側:那是「版面真的變了」,不是容差問題。
    expect(resolveGazeDock(anchor({ x: 5000, y: 4000 }), displays)).toEqual({
      action: 'fallback',
      stale: true
    })
  })

  it('外接螢幕上的錨點正常 dock(不能一律退回主螢幕)', () => {
    expect(resolveGazeDock(anchor({ displayId: 2, x: 2000, y: 16 }), displays)).toEqual({
      action: 'dock',
      x: 2000,
      y: 16
    })
  })
})

describe('anchorOnDisplay 容差', () => {
  it('±40 內算在(解析度微調的無害位移)', () => {
    expect(anchorOnDisplay(anchor({ x: -40, y: 0 }), primary)).toBe(true)
    expect(anchorOnDisplay(anchor({ x: 1919, y: 1079 }), primary)).toBe(true)
  })

  it('超出 ±40 就不認(那是版面真的變了)', () => {
    expect(anchorOnDisplay(anchor({ x: -41, y: 0 }), primary)).toBe(false)
    expect(anchorOnDisplay(anchor({ x: 1960, y: 0 }), primary)).toBe(false)
  })

  it('id 不符永遠找不到(即使座標數字剛好落在那台螢幕範圍內)', () => {
    expect(findAnchorDisplay(anchor({ displayId: 2 }), [primary])).toBeNull()
  })
})

describe('gazeInfo 設定頁狀態列', () => {
  it('未鎖定 → anchored:false,其餘欄位 null', () => {
    expect(gazeInfo(null, displays)).toEqual({
      anchored: false,
      stale: false,
      offsetPx: null,
      cameraLabel: null
    })
  })

  it('offsetPx = 錨點距螢幕物理上緣 + 文字帶在視窗內的偏移(兩段都要)', () => {
    // bounds.y 而不是 workArea.y:攝影機在螢幕物理上緣,工作列在哪與鏡頭無關。
    const info = gazeInfo(anchor({ y: 100 }), displays)
    expect(info.anchored).toBe(true)
    expect(info.stale).toBe(false)
    expect(info.offsetPx).toBe(100 - 0 + LENS_BAND_TOP_PX)
    expect(info.cameraLabel).toBe('Integrated Camera')
  })

  it('stale → offsetPx 讓位給 null(角度無從算起,不能回一個安靜錯掉的數字)', () => {
    const info = gazeInfo(anchor({ displayId: 42 }), displays)
    expect(info).toEqual({
      anchored: true,
      stale: true,
      offsetPx: null,
      cameraLabel: 'Integrated Camera'
    })
  })
})
