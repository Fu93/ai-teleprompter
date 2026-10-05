/**
 * audit-report.mjs — 稽核腳本共用的收集、斷言與輸出。
 *
 * 為什麼要抽出來:
 *   audit-ui.mjs 與 audit-deep.mjs 需要同一套「問題收集 + 狀態清單 + 輸出格式」。
 *   上一輪的問題正是兩支腳本各寫各的,導致 deep 的深狀態導航靜默 no-op 卻沒人發現
 *   —— 報告是空的,而空報告與「全清」長得一模一樣。
 *
 * 這支的三個職責:
 *   1. guardSerializable():在啟動時就驗證 domAudit 的原始碼真的能被瀏覽器解析。
 *      型別標註混進被序列化的函式是這個設計最脆弱的點,讓它在第一步就爆。
 *   2. 區分「量過而且乾淨」與「根本沒量到」:報告帶 meta.auditedStates 與
 *      meta.skippedStates,空問題清單不再是唯一的訊號。
 *   3. expectStateChange():深狀態導航後比對截圖 sha256。畫面沒變等於狀態沒到達,
 *      直接記一筆 state-unreached,不再讓它安靜地通過。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * domAudit 會被 page.evaluate 以 toString() 序列化後在頁面裡執行。
 * 只要有人加了型別標註,這裡就會在啟動時立刻失敗 —— 比等到某一頁莫名丟出
 * SyntaxError 好得多(那種錯誤會被 .catch 吞成 audit-failed,淹在報告裡)。
 */
export function guardSerializable(fn, label) {
  const src = fn.toString()
  // 檢查一:整段原始碼必須是合法 JS。型別標註若沒被抹除,這裡就會爆。
  // (Node 的 type stripping 會把標註代換成空白,所以 toString() 拿到的是已抹除的版本。
  //  換成會保留標註的工具鏈執行時,這一關會直接擋下來。)
  // eslint-disable-next-line no-new-func
  new Function(`return (${src})`)

  // 檢查二:不得引用模組層級識別字 —— 那些不會跟著被序列化,頁面裡是 undefined。
  // 只針對「模組層級的名字」,並先移除註解:註解裡說明「與模組層級的 X 同語意」
  // 是允許且必要的讀者指引,不該被當成違規。
  const noComments = src.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const forbidden = ['MIN_TAP_PX', 'MIN_FONT_PX', 'SMALL_TARGET_SELECTOR', 'isSmallTarget', 'clipperOf']
  const localDecls = new Set(
    [...noComments.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  )
  const offending = forbidden.filter((name) => !localDecls.has(name) && new RegExp(`\\b${name}\\b`).test(noComments))
  if (offending.length) {
    throw new Error(
      `${label} 引用了模組層級識別字(${offending.join(', ')}):它們不會跟著函式被序列化,` +
        ` 在頁面裡是 undefined。請在函式內內聯,或改寫成不依賴外部識別字的判斷。`
    )
  }
  return src.length
}

/** 截圖的內容指紋。用來判斷「這個狀態真的渲染了嗎」。 */
export function fileHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 拆開 domAudit 的回傳:問題項目 + 最後那筆 __tally。
 *
 * 為什麼要一個共用函式:三支稽核腳本(audit-deep / states / ui)都以完全相同的
 * 一行消費 domAudit 的結果,而 __tally 必須被**排除在問題之外** —— 它不是缺陷。
 * 三處各寫一遍的話,漏一處就是「某一支稽核把 tally 當成一筆問題報出去」,
 * 而那會讓問題數憑空 +1,進而污染 release-gate 的基線。
 *
 * 回傳 { problems, tally }:problems 是真的問題,tally 是每條規則的評估次數。
 */
export function splitDomFindings(dom) {
  const problems = []
  let tally = null
  for (const d of dom ?? []) {
    if (d && d.kind === '__tally') {
      try {
        tally = JSON.parse(d.text)
      } catch {
        tally = null
      }
      continue
    }
    problems.push(d)
  }
  return { problems, tally }
}

export function createReport(tool) {
  const problems = []
  const audited = []
  const skipped = []
  /**
   * 量到的數值(不是問題也不是狀態清單),例如「每個形態真正生效的視窗最小尺寸」。
   * 為什麼要記下來:這類斷言是「夾住了」與「沒問題」長得一樣的地方 ——
   * 只斷言「沒有低於下限」時,一個完全不生效的 setMinimumSize 也會通過。
   */
  const notes = {}
  /** 每條規則被評估的次數(見 tallyRule) */
  const ruleTally = Object.create(null)
  const STARTED_AT = new Date().toISOString()

  return {
    get length() {
      return problems.length
    },
    /** 記一筆問題 */
    add(kind, page, text) {
      problems.push({ kind, page, text })
    },
    /** 記一個量到的值(進 meta.notes,不影響問題數) */
    note(key, value) {
      notes[key] = value
    },
    /**
     * 累加「規則評估次數」。
     *
     * 為什麼需要:一個從未觸發過的規則與一個很有用的規則,在「問題數」裡
     * 長得一模一樣(都是 0)。`thin-slider` 就這樣存在了三輪 —— 它有名字、
     * 有註解、有門檻,但它量的東西量不到,所以永遠不會響。
     *
     * 這裡累加的是**有機會被評估**的次數,不是命中次數。兩者要分清楚:
     *   - 評估次數為 0 → 這條規則的觸發路徑根本沒被走到(這個頁面沒有 range)
     *   - 評估次數大、命中 0 → 條件真的都滿足,或者規則本身是壞的
     * 兩者都值得知道,但意義不同,所以報告分開顯示。
     */
    tallyRule(kind, n = 1) {
      // 傳物件 = 一次餵整包(domAudit 的 __tally 就是一個 kind→count 物件);
      // 傳字串 = 單筆 +n。用兩個簽名而不是拆成兩個函式,因為呼叫端只有一種
      // 使用情境(把一份 tally 併進來),多一個 API 就多一個能被忘記呼叫的地方。
      if (kind && typeof kind === 'object') {
        for (const [k, v] of Object.entries(kind)) {
          ruleTally[k] = (ruleTally[k] || 0) + (Number(v) || 0)
        }
        return
      }
      ruleTally[kind] = (ruleTally[kind] || 0) + n
    },
    /** 標記「這個狀態被完整量測過」。與 add 分開,才分得出乾淨與沒跑到。 */
    measured(label) {
      audited.push(label)
      return problems.length
    },
    /**
     * 狀態沒有真的到達。這一定要進 problems,否則報告會用「沒有問題」的方式
     * 掩蓋「沒有量測」—— 這正是上一輪的失敗模式。
     */
    unreached(label, reason) {
      skipped.push({ label, reason })
      problems.push({ kind: 'state-unreached', page: label, text: reason })
    },
    /**
     * 深狀態導航後斷言畫面真的變了。prevHash 為 null(第一次)時不判斷。
     * 這一條是整個稽核可信度的關鍵:文字 regex 找不到按鈕、點擊被 disabled 擋掉、
     * React 狀態沒更新 —— 全都會表現成「截圖一模一樣」。
     */
    expectStateChange(label, prevHash, nextHash) {
      if (!prevHash || !nextHash) return true
      if (prevHash === nextHash) {
        this.unreached(label, `截圖與上一個狀態完全相同(${nextHash.slice(0, 12)}…):操作沒有生效`)
        return false
      }
      return true
    },
    /** 摘要 + 寫檔。回傳問題陣列給呼叫端決定 exit code。 */
    finish(outFile) {
      const byKind = problems.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {})
      const payload = {
        meta: {
          tool,
          startedAt: STARTED_AT,
          finishedAt: new Date().toISOString(),
          auditedStates: audited,
          skippedStates: skipped,
          problemCount: problems.length,
          byKind,
          ruleTally,
          notes
        },
        problems
      }
      if (outFile) writeFileSync(outFile, JSON.stringify(payload, null, 2))

      console.log('')
      console.log(`=== ${tool} 結果 ===`)
      console.log(`量測狀態 ${audited.length} 個,問題 ${problems.length} 筆`)
      console.log('分類: ' + (Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(', ') || '(無)'))
      // 規則覆蓋率:每條規則被評估了幾次。
      //
      // 為什麼要印出來:「問題 0 筆」有兩種完全不同的意思 —— 「量了很多、沒問題」
      // 與「量不到東西」。只看問題數分不出來,而 `thin-slider` 就是靠這一點
      // 藏了三輪。評估次數為 0 的規則是**資訊**(這個頁面沒有那種元素),
      // 但它值得被看見,否則沒有人會知道那條規則從來沒被檢查過。
      const tallyEntries = Object.entries(ruleTally).sort((a, b) => a[1] - b[1])
      if (tallyEntries.length) {
        console.log('')
        console.log('規則評估次數(0 = 觸發路徑沒被走到,不代表規則有問題):')
        for (const [k, v] of tallyEntries) {
          const flag = v === 0 ? '  ⚠️ 從未評估' : ''
          console.log(`   ${k}: ${v}${flag}`)
        }
      }
      if (skipped.length) {
        console.log('')
        console.log(`⚠️ 有 ${skipped.length} 個狀態沒有真的到達 —— 這份報告的涵蓋率不完整:`)
        for (const s of skipped) console.log(`   - ${s.label}: ${s.reason}`)
      }
      if (audited.length === 0) {
        console.log('')
        console.log('⚠️ 一個狀態都沒量到。這不是「全清」,這是稽核沒有跑起來。')
      }
      console.log('')
      for (const p of problems) {
        console.log(`[${p.page}] ${p.kind}`)
        console.log(`    ${p.text}`)
      }
      if (outFile) console.log(`\n報告: ${outFile}`)
      return problems
    }
  }
}
