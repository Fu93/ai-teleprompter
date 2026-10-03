/**
 * aiAbort.ts — 在飛 AI 請求的登錄表(renderer 按 requestId 取消)。
 *
 * ── 為什麼要抽出來 ──
 *   `abortOllamaChat` 與它的 `abortControllers` map 從一開始就在 ollama.ts,
 *   整條鏈路也早就完整:`IPC.OllamaAbort` handler、`preload.ollamaAbort`、
 *   `api.ts` 的簽章、ollama.ts 裡正確的 `catch` 轉「已取消」。
 *
 *   **而它沒有任何呼叫端。** 四個 AI 呼叫點(Practice 出題、逐題回饋、
 *   整體總評、Record 摘要)的主按鈕都是 `disabled={busy !== null}`,
 *   使用者只能等:雲端 provider 逾時 10 秒,本地 Ollama 首次回答常更久。
 *   `GenerationGate` 能丟棄晚到的結果,但不能**終止**請求 —— 連線開著、
 *   雲端那邊仍在計費。
 *
 * ── 為什麼連雲端路徑一起收進來 ──
 *   原本的 map 只服務 ollama。但 openAiChat 走同一個 fetch,
 *   同樣可能掛住 180 秒(`AbortSignal.timeout(180_000)`)——
 *   而「只讓本地 Ollama 可取消、雲端不可取消」是使用者最不會預期的組合:
 *   他按了取消,本機模型停了,雲端的還在跑。
 *
 *   所以這裡是**共用**登錄表,兩條路徑用同一個 requestId 命名空間。
 *
 * ── 為什麼 renderer 不能自己中止 ──
 *   fetch 發生在 main 進程。renderer 的 AbortSignal 不跨進程邊界,
 *   它只能透過 IPC 請 main 轉呼叫這裡的 abort()。這也解釋了為什麼
 *   「取消」在使用者按下到實際中止之間有一個 IPC 往返的延遲。
 */
const controllers = new Map<string, AbortController>()

/** 開始追蹤一個請求;回傳的 controller 要接到 fetch 的 signal。 */
export function trackRequest(requestId: string): AbortController {
  // 同一個 requestId 重複進來(理論上不該發生)時,先把舊的收掉,
  // 否則舊請求會永遠留在 map 裡 —— 那個 map 是 module 級的,撐到 app 結束。
  controllers.get(requestId)?.abort()
  const controller = new AbortController()
  controllers.set(requestId, controller)
  return controller
}

/**
 * 請求結束(成功/失敗/逾時)時呼叫,把它從 map 移除。
 *
 * 沒有這一步的話,map 會隨著使用者的每一次 AI 呼叫單調成長 ——
 * 而它是 module 級的,撐到 app 結束。長時間使用的機器上那是幾千個
 * AbortController 的洩漏。
 */
export function releaseRequest(requestId: string): void {
  controllers.delete(requestId)
}

/**
 * 使用者按下取消。回傳是否真的中止了什麼。
 *
 * 回傳值讓呼叫端(IPC handler)能區分「取消了」與「那個請求已經結束了」——
 * 後者不是錯誤,只是按得太慢。
 */
export function abortRequest(requestId: string): boolean {
  const controller = controllers.get(requestId)
  if (!controller) return false
  controller.abort()
  controllers.delete(requestId)
  return true
}

/** 測試用:目前有幾個請求在飛。 */
export function trackedCount(): number {
  return controllers.size
}
