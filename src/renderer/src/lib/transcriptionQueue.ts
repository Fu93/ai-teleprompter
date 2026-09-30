/**
 * transcriptionQueue.ts — 「已送出但還沒回來的」語音辨識請求的追蹤與收帳。
 *
 * 為什麼要抽出來:
 *   Record(錄音轉錄)與 Practice(面試練習)都需要同一件事 —— 停止時不能只憑
 *   「目前收到幾段」猜測在飛的辨識是否完成,否則最後一句話會被丢掉。兩邊原本
 *   各抄一份(Map<id, Set<Promise>> 加上 Promise.race),而 Practice 那份還漏了
 *   把等待狀態反映到 UI,結果是「按了沒反應、最長 65 秒」的假死按鈕
 *   (stopListening 立刻把 recording 設 false,按鈕換回可點的「開始回答」,
 *    但 finishingRef 讓點擊靜默失效)。
 *
 *   抽出來之後:行為只有一份、可以單元測試(時限與完成判定是本模組最容易被
 *   寫錯的地方),而呼叫端只負責把結果反映到 UI。
 */

/**
 * 連續幾個段落辨識失敗後,就不再吐 toast 而改用持續橫幅。
 *
 * 為什麼放在這裡(而不是各頁自己寫一個):Record 與 Practice 面對的是同一件事
 * ——「我在白講」必須被看見,而且要在同樣的時機被看見。兩頁各寫一份數字,
 * 遲早會出現「Record 第 3 段開始警告、Practice 第 5 段才警告」這種不一致,
 * 而使用者對這種差異的結論只會是「這個 App 的提示不太可靠」。
 * 3 是刻意選的:足夠濾掉「模型還在載入所以前兩段失敗」的雜訊,又能在使用者
 * 真的在講話時很快讓他發現。
 */
export const STT_FAILURE_BANNER_THRESHOLD = 3

/** drainPending 的結果 */
export interface DrainResult {
  /** 是否在時限內全部落地。false = 逾時,呼叫端要自己決定要不要提示使用者 */
  drained: boolean
  /** 逾時當下仍未完成的請求數(精確值,不是估算) */
  outstanding: number
  elapsedMs: number
}

/**
 * 等到所有在飛的辨識請求落地,或逾時。
 *
 * 為什麼用 allSettled 而不是 all:辨識失敗(雲端 401、模型沒下載)也必須算
 * 「這個請求結束了」,否則一個失敗的請求會讓收帳一路等到逾時。
 *
 * 逾時的預設理由:雲端 ASR 自己就有 60 秒 timeout,本地模型冷啟動也可能數十秒。
 * 等到那個數量級之後,繼續等下去對使用者的傷害(整場會議沒存到)大於先收帳
 * (可能少最後一句)。
 */
export async function drainPending(
  pending: Array<Promise<unknown>>,
  timeoutMs: number
): Promise<DrainResult> {
  const startedAt = Date.now()
  if (pending.length === 0) return { drained: true, outstanding: 0, elapsedMs: 0 }

  let settled = 0
  const tracked = pending.map((p) =>
    p.then(
      () => {
        settled += 1
      },
      () => {
        settled += 1
      }
    )
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const drained = await Promise.race([
      Promise.allSettled(tracked).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
    ])
    return {
      drained,
      outstanding: pending.length - settled,
      elapsedMs: Date.now() - startedAt
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 依「場次/題號」分組追蹤在飛的辨識請求。
 *
 * 分組是必要的而不是為了好看:停止錄音後隔離舊場次時,晚到的辨識結果必須
 * 被丟掉而不是寫進下一場會議。呼叫端拿 key 比對 sessionId / answerId。
 */
export interface PendingTracker<K> {
  /** 開始追蹤一個請求;它 settle 之後自動從集合移除 */
  track: (key: K, job: Promise<unknown>) => void
  /** 取出該 key 目前仍在飛的請求(呼叫端接著把它交給 drainPending) */
  take: (key: K) => Array<Promise<unknown>>
  /** 該 key 目前有幾個在飛 */
  size: (key: K) => number
}

export function createPendingTracker<K>(): PendingTracker<K> {
  const map = new Map<K, Set<Promise<unknown>>>()

  const drop = (key: K, job: Promise<unknown>, set: Set<Promise<unknown>>): void => {
    set.delete(job)
    if (set.size === 0) map.delete(key)
  }

  return {
    track: (key, job) => {
      let set = map.get(key)
      if (!set) {
        set = new Set<Promise<unknown>>()
        map.set(key, set)
      }
      const current = set
      set.add(job)
      // 成功與失敗都要移除:失敗的請求也已經結束了
      void job.then(
        () => drop(key, job, current),
        () => drop(key, job, current)
      )
    },
    take: (key) => [...(map.get(key) ?? [])],
    size: (key) => map.get(key)?.size ?? 0
  }
}
