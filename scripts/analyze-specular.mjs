// 像素分析:比較 specular 開/關時,藥丸「最外圈列」與「內部列」的亮度。
//
// 判讀方式:同一張圖裡,邊緣列的亮度應該 ≤ 內部列。
// 邊緣比內部亮 = 峰值落在最外圈像素 = 使用者會看到一圈白邊,
// 跟先前 dynamic-island 光暈是同一種失敗型態。
// 開/關兩張相減,則是 specular 本身貢獻了多少邊緣亮度。
import sharp from 'sharp'

const rowsOf = async (path) => {
  const { width, height } = await sharp(path).metadata()
  const { data } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
  const ch = data.length / width / height
  const out = []
  for (let y = 0; y < height; y++) {
    let sum = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    out.push(sum / width)
  }
  return { rows: out, width, height }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length

for (const name of ['top', 'mid', 'bottom']) {
  const on = await rowsOf(`docs/audit/spec/pill-${name}.png`)
  const off = await rowsOf(`docs/audit/spec/pill-${name}-off.png`)
  const h = on.height
  const inner = avg(on.rows.slice(Math.floor(h * 0.35), Math.ceil(h * 0.65)))
  const edge = avg([on.rows[0], on.rows[h - 1]])
  const edgeOff = avg([off.rows[0], off.rows[h - 1]])
  const innerOff = avg(off.rows.slice(Math.floor(h * 0.35), Math.ceil(h * 0.65)))
  const ratio = edge / inner
  const deltaEdge = edge - edgeOff
  console.log(`游標在 ${name.padEnd(6)}:`)
  console.log(`  高光開:邊緣 ${edge.toFixed(1)} / 內部 ${inner.toFixed(1)} → 比值 ${ratio.toFixed(3)} ${ratio <= 1 ? '✓' : '✗ 邊緣比內部亮'}`)
  console.log(`  高光關:邊緣 ${edgeOff.toFixed(1)} / 內部 ${innerOff.toFixed(1)} → 比值 ${(edgeOff / innerOff).toFixed(3)}`)
  console.log(`  specular 對邊界的貢獻: +${deltaEdge.toFixed(1)}`)
  const w = on.width
  // 左右兩端的欄平均,確認圓角處沒有亮弧
  const { data } = await sharp(`docs/audit/spec/pill-${name}.png`).raw().toBuffer({ resolveWithObject: true })
  const ch = data.length / w / h
  const col = (x) => {
    let s = 0
    for (let y = 0; y < h; y++) { const i = (y * w + x) * ch; s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] }
    return s / h
  }
  const l = col(0), r = col(w - 1)
  const c = col(Math.floor(w / 2))
  console.log(`  水平:最左 ${l.toFixed(1)} / 中央 ${c.toFixed(1)} / 最右 ${r.toFixed(1)}  左邊比中央 ${(l / c).toFixed(3)}${l > c * 1.05 ? ' ✗' : ' ✓'}`)
  console.log('')
}
