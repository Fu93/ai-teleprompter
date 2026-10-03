import { describe, it, expect } from 'vitest'
import { registerNavigator, navigateTo, type NavPage } from '../nav'

/**
 * nav.ts 的註冊/訂閱語意。
 *
 * 為什麼這支測試值得存在(而且是「行為」測試不是「mock 數量」測試):
 * App 端用一個永遠指向最新 navigate 的 ref 註冊,因為 navigate 會讀到當下的
 * 守衛狀態(scriptsDirty / leaveGuard)。當初那版把 navigate 直接放進 effect
 * 依賴,eslint 的 exhaustive-deps 抓到「missing dependency: navigate」——
 * 而那不是格式偏好,是真的資料遺失:登錄進去的是 scriptsDirty=false 的舊閉包,
 * 使用者按「前往設定」時守衛失效、未存內容消失。
 *
 * 這裡測的是註冊端**能被取代**這件事,因為那正是那個 bug 的反面。
 */
describe('nav 註冊橋', () => {
  // 每個 case 自己退訂,不靠 afterEach 全域清理:依賴「上一個 case 沒清乾淨」
  // 只會讓這支測試在重跑順序改變時神祕地失敗。

  it('沒有登錄時不做任何事,也不拋錯', () => {
    // overlay 視窗沒有 navigate,但它 import 了這支檔案 —— 拋錯會讓浮層起不來。
    expect(() => navigateTo('settings')).not.toThrow()
  })

  it('登錄之後 navigateTo 會呼叫登錄的函式', () => {
    const calls: NavPage[] = []
    const off = registerNavigator((p) => void calls.push(p))
    try {
      navigateTo('record')
      navigateTo('settings')
      expect(calls).toEqual(['record', 'settings'])
    } finally {
      off()
    }
  })

  it('退訂之後就不再被呼叫(overlay 卸載時不留幽靈按鈕)', () => {
    const calls: NavPage[] = []
    const off = registerNavigator((p) => void calls.push(p))
    off()
    navigateTo('settings')
    expect(calls).toEqual([])
  })

  it('退訂只影響自己那一個,不會把別人剛登錄的清掉', () => {
    // StrictMode 會把 effect 跑兩次:第一次的清理函式不能把第二次登錄的
    // navigator 清成 null。那會讓按鈕在第二次掛載之後安靜失效 ——
    // 不報錯、沒有 console,只是按了沒反應。
    const firstCalls: NavPage[] = []
    const secondCalls: NavPage[] = []
    const offFirst = registerNavigator((p) => void firstCalls.push(p))
    const offSecond = registerNavigator((p) => void secondCalls.push(p))
    offFirst()
    try {
      navigateTo('scripts')
      expect(firstCalls).toEqual([])
      expect(secondCalls).toEqual(['scripts'])
    } finally {
      offSecond()
    }
  })

  it('後登錄的取代先登錄的(後者必須先退訂才不會誤傷)', () => {
    const firstCalls: NavPage[] = []
    const secondCalls: NavPage[] = []
    const offFirst = registerNavigator((p) => void firstCalls.push(p))
    const offSecond = registerNavigator((p) => void secondCalls.push(p))
    try {
      navigateTo('dashboard')
      expect(firstCalls).toEqual([])
      expect(secondCalls).toEqual(['dashboard'])
    } finally {
      offFirst()
      offSecond()
    }
  })
})

/**
 * 導航回傳值:可行動錯誤(toast 的「前往設定」)依賴它決定「要不要收起自己」。
 *
 * 缺陷是:runAction 原本在導航後無條件收起 toast,而導航可能被未存變更守衛
 * 攔下(使用者選「留在此頁」)—— 那張卡片是那個錯誤唯一的下一步,它先消失了,
 * 使用者修完手上的事就再也回不到建議的那一步。
 *
 * 負向驗證:把 navigateTo 改回無條件 resolve true(或讓 ToastHost 無條件
 * onDone()),第一條測試變紅。
 */
describe('nav 導航結果(可行動 toast 依賴它)', () => {
  it('navigator 回 false(被守衛攔下)→ navigateTo 解析 false,toast 不該收起', async () => {
    const off = registerNavigator(() => false)
    try {
      await expect(navigateTo('settings')).resolves.toBe(false)
    } finally {
      off()
    }
  })

  it('navigator 回 true(已換頁)→ navigateTo 解析 true', async () => {
    const off = registerNavigator(() => true)
    try {
      await expect(navigateTo('settings')).resolves.toBe(true)
    } finally {
      off()
    }
  })

  it('async navigator 的結果會被等出來(守衛的確認對話框是 async)', async () => {
    const off = registerNavigator(async () => {
      await new Promise((r) => setTimeout(r, 1))
      return false
    })
    try {
      await expect(navigateTo('record')).resolves.toBe(false)
    } finally {
      off()
    }
  })

  it('回 void 的舊呼叫端視為「已達成」(向後相容)', async () => {
    const calls: NavPage[] = []
    const off = registerNavigator((p) => void calls.push(p))
    try {
      await expect(navigateTo('record')).resolves.toBe(true)
    } finally {
      off()
    }
  })

  it('沒有 navigator(浮層視窗)時視為已達成 —— 不讓 toast 永遠停著', async () => {
    await expect(navigateTo('settings')).resolves.toBe(true)
  })
})
