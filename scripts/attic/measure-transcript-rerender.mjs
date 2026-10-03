/**
 * 量測「每新增一段逐字稿,整份列表重繪」的實際成本。
 *
 * 這是一次性的量測工具(不是測試):目的是在動 Record.tsx 之前,先確認
 * 「N 越大、每次新增越慢」到底是真的,還是想像出來的。沒有數字就沒有結論。
 *
 * 執行:node scripts/attic/measure-transcript-rerender.mjs
 */
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { performance } from 'perf_hooks'

/** 照抄 Record.tsx 的逐字稿列結構 —— 結構不同,量到的數字就沒有意義。 */
function Row({ seg }) {
  return createElement(
    'div',
    { key: `${seg.start}-${seg.end}-${seg.speaker}`, className: 'flex gap-3' },
    createElement('div', { className: 'w-24 shrink-0 pt-0.5 text-right font-mono text-[10px]' }, seg.time),
    createElement(
      'div',
      { className: 'min-w-0 flex-1' },
      createElement(
        'span',
        {
          className:
            seg.speaker === 'me'
              ? 'mr-2 rounded px-1.5 py-0.5 text-[10px] bg-accent-500/20 text-accent-300'
              : 'mr-2 rounded px-1.5 py-0.5 text-[10px] bg-sky-500/20 text-sky-300'
        },
        seg.speaker === 'me' ? '我' : '對方'
      ),
      createElement('span', { className: 'text-sm leading-relaxed' }, seg.text)
    )
  )
}

function List({ segments }) {
  return createElement(
    'div',
    { className: 'space-y-3' },
    segments.map((seg) => createElement(Row, { key: `${seg.start}-${seg.end}-${seg.speaker}`, seg }))
  )
}

/** 造 N 段帶真實長度中文的逐字稿。 */
function makeSegments(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      start: i * 30,
      end: i * 30 + 12,
      speaker: i % 2 === 0 ? 'me' : 'them',
      time: `${String(Math.floor((i * 30) / 60)).padStart(2, '0')}:${String((i * 30) % 60).padStart(2, '0')}`,
      text: `這是第 ${i} 段的逐字稿內容,長度接近真實語音辨識輸出的一句話,大約二十幾個中文字。`
    })
  }
  return out
}

function bench(n, iterations) {
  const segs = makeSegments(n)
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) {
    renderToString(createElement(List, { segments: segs }))
  }
  return (performance.now() - t0) / iterations
}

/**
 * 取多次重複的中位數。
 *
 * 為什麼不用單次平均:第一版量測把 50 段量成 12.4ms、200 段量成 5.0ms ——
 * N 兩倍的項目反而「更快」,那不是結論,是 JIT 還沒熱身。所以這裡先全局熱身,
 * 再對每個 N 重複取樣,並且用中位數(對偶發的 GC 停頓免疫)。
 */
function measure(n) {
  const samples = []
  const iterations = n <= 200 ? 40 : 15
  for (let rep = 0; rep < 5; rep++) samples.push(bench(n, iterations))
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)] / iterations
}

// 全局熱身:先讓 JIT 把 renderToString 與 React 的建立路徑編譯完,否則
// 量測順序會決定結果 —— 而那正是第一版假結論的來源。
for (const n of [50, 200, 500, 1000, 2000]) {
  const segs = makeSegments(n)
  for (let i = 0; i < 20; i++) renderToString(createElement(List, { segments: segs }))
}

console.log('每次新增一段 = 整份列表重繪一次(這就是 Record.tsx 現況)')
console.log('段落數 |  單次重繪耗時(中位數)')
console.log('------|---------------------')
const rows = []
for (const n of [50, 200, 500, 1000, 2000]) {
  const ms = measure(n)
  rows.push({ n, ms })
  console.log(String(n).padStart(6), '|', ms.toFixed(2).padStart(13), 'ms')
}

// 成長率:相對 50 段,每多 10 倍要付出幾倍
const base = rows[0].ms
console.log('\n相對 50 段的倍數(純線性成長會是 4 / 10 / 20 / 40):')
for (const r of rows.slice(1)) {
  const expected = r.n / rows[0].n
  const actual = r.ms / base
  console.log(
    String(r.n).padStart(5),
    '→',
    actual.toFixed(1).padStart(6),
    '倍 (線性預期',
    expected.toFixed(0).padStart(3),
    ')',
    actual < expected * 1.3 ? '≈ 線性' : '★ 超線性'
  )
}

const worst = rows[rows.length - 1]
console.log(
  `\n結論:${worst.n} 段的會議,每多說一句話就要花 ${worst.ms.toFixed(1)}ms 重繪整份逐字稿。`
)
console.log(
  worst.ms < 16.7
    ? '低於一影格(16.7ms),畫面上不會有可感知的卡頓 —— 不值得為它改架構。'
    : `超過一影格(16.7ms) ${(worst.ms / 16.7).toFixed(1)} 倍,值得處理。`
)
