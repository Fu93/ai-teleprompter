// 像素分析滑桿局部截圖,驗證「軌道高度」與「命中高度」分離後畫得對不對。
//
// 為什麼需要這支:computed style 顯示 height 22px 並不代表畫面正確 ——
// 軌道與滑塊現在畫在不同層(::-webkit-slider-runnable-track 與
// ::-webkit-slider-thumb),萬一置中有偏差,肉眼在深色卡片上不一定看得出來。
// 這個專案的白邊問題就是這樣查出來的:量測,不要靠印象。
//
// 先跑 scripts/audit-slider.mjs 產生 docs/audit/_slider.png,再跑本檔。
//
// 寫這支時踩到的兩個坑(都留在程式裡提醒):
//  1. 背景值用「出現最多次的 rowMax」估會被滑塊騙到 —— 滑塊 17 列全白
//     剛好比背景列數多一列,於是背景被判成 255,整張圖失準。改用最暗值。
//  2. 只看前 60 欄找滑塊,但預設值不在最小值,滑塊在更右邊,整個找不到。
//     必須掃滿寬度。
// 另外截圖上緣的白色 label 文字會被誤認成滑塊,截圖時的 pad 要小於
// label 與 input 之間的 8px 間距(audit-slider.mjs 裡用 6px)。
import sharp from 'sharp'

const IMG = process.argv[2] || 'docs/audit/_slider.png'
const { width, height } = await sharp(IMG).metadata()
const { data } = await sharp(IMG).raw().toBuffer({ resolveWithObject: true })
const ch = data.length / width / height

const rowMax = []
for (let y = 0; y < height; y++) {
  let max = 0
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * ch
    const v = Math.max(data[i], data[i + 1], data[i + 2])
    if (v > max) max = v
  }
  rowMax.push(max)
}

// 背景 = 最暗的 rowMax。用「出現最多次」會被滑塊騙到:
// 滑塊 17 列全白剛好比背景列數多一列,於是背景被判成 255,整張圖失準。
const bg = Math.min(...rowMax)

// 每列有多少像素高於背景 —— 用來區分「軌道(整條橫幅)」與「滑塊(局部圓形)」
const rowCount = []
for (let y = 0; y < height; y++) {
  let n = 0
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * ch
    if (Math.max(data[i], data[i + 1], data[i + 2]) > bg + 12) n++
  }
  rowCount.push(n)
}

console.log(`背景亮度 = ${bg}`)
console.log('')
console.log('y   rowMax  寬於背景的像素數  分類')
for (let y = 0; y < height; y++) {
  const v = rowMax[y]
  const n = rowCount[y]
  let kind = ''
  if (v > 200) kind = n > width * 0.5 ? '軌道被滑塊蓋住?' : '滑塊(純白)'
  else if (v > bg + 12) kind = n > width * 0.5 ? '軌道(滿寬)' : '局部亮塊'
  console.log(`${String(y).padStart(2)}  ${String(v).padStart(5)}  ${String(n).padStart(5)}  ${kind}`)
}

const track = []
const thumb = []
for (let y = 0; y < height; y++) {
  if (rowMax[y] > 200) thumb.push(y)
  else if (rowMax[y] > bg + 12) track.push(y)
}
const span = (a) => (a.length ? `${a.length}px  y=${a[0]}..${a[a.length - 1]}` : '無')
console.log('')
console.log(`軌道列: ${span(track)}`)
console.log(`滑塊列: ${span(thumb)}`)
if (track.length && thumb.length) {
  const tc = (track[0] + track[track.length - 1]) / 2
  const hc = (thumb[0] + thumb[thumb.length - 1]) / 2
  console.log(`軌道中心 y=${tc}  滑塊中心 y=${hc}  偏移 ${hc - tc}px`)
}

// 滑塊水平範圍,確認是完整圓形而不是被切掉
if (thumb.length) {
  const y0 = thumb[0]
  const y1 = thumb[thumb.length - 1]
  let xMin = width
  let xMax = -1
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 200) {
        if (x < xMin) xMin = x
        if (x > xMax) xMax = x
      }
    }
  }
  const w = xMax - xMin + 1
  const h = y1 - y0 + 1
  // 圓周是抗鋸齒的,>200 的門檻會吃掉最外圈那一列,量出來通常是 17 而非 18。
  // 差 1px 視為通過,否則這支工具會一直報一個不存在的問題。
  const round = Math.abs(w - h) <= 1 && w >= 17 && w <= 19
  console.log(
    `滑塊水平 x=${xMin}..${xMax}  尺寸 ${w}x${h}  ${round ? '正圓(±1px 為抗鋸齒)✓' : '非正圓 ✗'}`
  )
}
