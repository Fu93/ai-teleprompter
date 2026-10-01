/**
 * mock-services.mjs — 兩個只存在於稽核期間的本機伺服器。
 *
 * 為什麼稽核需要「假的外部服務」:
 *   AI 摘要、面試練習的出題與評分、雲端語音辨識 —— 這三條都是**產品的主要路徑**,
 *   而它們原本一個都量不到,因為它們都要一台真的伺服器(或一個 500MB 的模型)。
 *   於是它們只能被歸類成 unverifiable,而「提詞機的 AI 到底會不會動」
 *   從來沒被任何一支稽核碰過。
 *
 *   量不到外部服務,不代表量不到「接線」:**把服務換成一個回固定答案的本機 HTTP**,
 *   整條 IPC → provider 解析 → fetch → 解析回應 → 寫進 store 的路徑就全部真的跑過一次。
 *   `playtest3.spec.ts` 用這個做法驗過雲端 STT(那條測試就是 mock server),這裡把它
 *   收斂成可共用的兩支,讓稽核不必自己重寫一次。
 *
 * 這條路徑量到什麼、沒量到什麼(照實寫,免得讀報告的人高估):
 *   量到:設定真的被 provider 解析、請求真的送出去、回應真的被解析、
 *         結果真的進了使用者的資料層、UI 真的因此改變。
 *   沒量到:模型回答的品質。那是模型的事,不是這個 App 的事。
 */
import http from 'node:http'

/** 監聽 127.0.0.1 的隨機埠,回傳 port 與 close()。 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ port, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

/**
 * 雲端 STT(POST /audio/transcriptions)。
 *
 * 回傳固定的逐字稿 —— 內容刻意包含一個可辨識的關鍵詞,
 * 讓探針能斷言「浮層/逐字稿裡真的出現了辨識結果」,而不是只斷言「沒有報錯」。
 */
export async function startMockStt(text = '稽核測試逐字稿:我們先確認收音有沒有進來。') {
  const requests = []
  const svc = await listen(async (req, res) => {
    const body = await readBody(req)
    requests.push({ url: req.url, method: req.method, bytes: body.length, auth: req.headers.authorization ?? null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ text }))
  })
  return {
    ...svc,
    text,
    requests,
    /** 有沒有真的收到音訊位元組(而不是空 body)。這是「錄音內容有送出去」的證據。 */
    audioBytes: () => requests.reduce((n, r) => n + r.bytes, 0)
  }
}

/**
 * Ollama 形狀的 LLM(POST /api/chat)。
 *
 * 為什麼用 Ollama 形狀而不是 OpenAI 形狀:
 *   `lib/ai.ts` 在 provider==='ollama' 時走 `ollamaChat` → 主程序的
 *   normalizeOllamaEndpointUrl → `<baseUrl>/api/chat`。回傳 `{message:{content}}`
 *   就夠了,不需要金鑰、不需要安全儲存,少一層可能出錯的東西。
 *
 * reply 可以是字串(固定回答)或函式(依請求內容決定)→ 後者讓「同一支伺服器
 * 同時當出題與評分」變成可能,而不必分辨呼叫來源。
 */
/**
 * 兩個模型而不是一個:Ollama 的模型選單只在「不只一個」時驗得出「選了真的生效」。
 * 一個選項的選單找不到「跟現值不同的目標」,而那不是產品的缺陷。
 */
export async function startMockLlm(defaultReply, { models = ['mock-qwen', 'mock-qwen:7b'] } = {}) {
  const requests = []
  const prompts = []
  const svc = await listen(async (req, res) => {
    const raw = await readBody(req)
    /**
     * /api/tags:Ollama 的「你裝了哪些模型」。
     *
     * 為什麼這條一定要在**同一個 origin**上:
     *   產品的 Ollama 分支有前置檢查(`ollamaListModels` → 沒有模型就不出題、
     *   preflight 也會說引擎沒裝)。第一版把 tags 留在另一支沒被啟動的伺服器上,
     *   於是面試練習的「開始練習」按下去只得到一句錯誤 toast ——
     *   而稽核把它記成「按鈕沒有效果」。那是假缺陷:錯的是探針的環境,不是產品。
     *   一個 origin 同時回答 chat 與 tags,前置條件才跟真實的 Ollama 一致。
     */
    if (req.url?.startsWith('/api/tags')) {
      requests.push({ url: req.url, method: req.method, bytes: 0, tags: true })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }))
      return
    }
    /**
     * /api/version:Ollama 的「我存在嗎」。
     *
     * 少了這一條的症狀很間接:產品把「installed」定義成
     * `ollamaVersion() !== null`（ipc.ts 的 OllamaListModels）,而
     * `ollamaVersion` 只認回應裡的 `version` 欄位。沒有這一條時請求會落到
     * 底下的聊天形狀 `{model, message, done}` —— HTTP 200,但沒有 version →
     * installed=false → `Practice.startPractice` 的前置檢查擲出
     * 「無法連線到 Ollama」→ /api/chat 一次都發不出去。
     *
     * 而症狀看起來完全像產品壞了:「按了開始練習但進不了 run 階段」。
     * 這是連續第三個「mock 不夠像被替的東西,於是量到的是 mock 的缺口」。
     */
    if (req.url?.startsWith('/api/version')) {
      requests.push({ url: req.url, method: req.method, bytes: 0, version: true })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ version: '0.0.0-audit' }))
      return
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      /* 保留下面的 requests 記錄即可 */
    }
    const messages = parsed?.messages ?? []
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user')?.content ?? ''
    requests.push({ url: req.url, model: parsed?.model ?? null, userChars: String(lastUser).length })
    // 保留整段 prompt:稽核要能斷言「設定頁上選的職位/題數真的被帶進出題請求」,
    // 而不是只看「有沒有回應」。這是 data-layer 證據的一種 —— 它來自本機那端的
    // 伺服器,不是被點的那顆按鈕。
    if (req.url?.startsWith('/api/chat')) prompts.push(String(lastUser))

    const reply =
      typeof defaultReply === 'function'
        ? defaultReply({ messages, lastUser: String(lastUser), body: parsed })
        : defaultReply

    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ model: parsed?.model ?? 'mock', message: { role: 'assistant', content: reply }, done: true }))
  })
  return {
    ...svc,
    requests,
    prompts,
    models,
    calls: () => requests.filter((r) => !r.tags && !r.version).length,
    tagsCalls: () => requests.filter((r) => r.tags).length,
    versionCalls: () => requests.filter((r) => r.version).length,
    /** 最近一次(或任何一次)prompt 裡有沒有出現這個字串。 */
    lastPromptContains: (needle) => prompts.some((p) => p.includes(needle))
  }
}

/** Ollama 的模型清單(preflight 會問它)。沒有它,設定頁會一直說引擎連不上。 */
export async function startMockOllamaTags(models = ['mock-qwen']) {
  return listen((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url?.startsWith('/api/tags')) {
      res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }))
      return
    }
    res.end(JSON.stringify({ models: [] }))
  })
}
