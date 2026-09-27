# 精緻度(UI Polish)研究綜合報告(2026-09-27)

> 四路子代理研究:**①** Apple 原生執行細節(Dynamic Island spring 實測值、Liquid Glass 複刻參數)、**②** 影音錄製產品 UX(Descript/Tella/Loom/Riverside/OBS)、**③** 頂級生產力應用精緻度拆解(Linear/Raycast/Notion/Arc/Superhuman/Things/Slack/Warp)、**④** 主流設計系統 token 實測(Primer/Polaris/Fluent 2/Atlassian/Radix)。本文件只留可執行結論與我們的差距。

## 十字路口:四份報告交叉驗證出的「精緻度公理」

1. **深度靠亮度階梯 + 髮絲線,不靠陰影堆疊**(③④):Linear canvas→surface 共 4 級亮度;暗色浮層陰影必須帶 `0 0 0 1px rgba(255,255,255,0.08~0.12)` 亮環,否則融進背景。
2. **Accent 紀律**:一個 viewport 一個實心色塊(Linear「never decoratively」/Slack/Raycast 同規)。indigo 只給:主 CTA、focus ring、選取態、進度、錄製中。其餘 chrome 白灰階。
3. **動效預算**:UI <300ms、ease-out;**鍵盤觸發與高頻操作零動畫**;press = scale 0.97;hover 用亮度/白 20% 覆蓋層(Primer/Atlassian/Fluent 暗色統一量級),不換底色。
4. **可中斷 spring + 非對稱阻尼**(①):展開 ζ≈0.8 有彈(response 0.42 → stiffness 224/damping 24)、收合 ζ=1.0 零彈跳(0.45 → 195/28);內容 crossfade 舊 90ms 出、新延遲 120ms 從 1.04 縮回;中途觸發要**保留速度改道**,不能 cancel+restart。
5. **同心圓角**:內容圓角 = 外殼圓角 − 內距(WWDC「blur 一下看輪廓」);pill 半徑 = height/2,全程連續內插。
6. **精度降級取代截斷**:compact 太窄時顯示較不精確的值(MM:SS),永不出現「…」。

## 我們目前的差距(自我審計 × 研究規格)

| # | 差距 | 依據 | 修正 |
|---|---|---|---|
| 1 | overlay 開啟掛了 0.35s rise-in — 鍵盤觸發(Ctrl+Alt+T)應零動畫 | ③高頻零動畫 | 移除 overlay 根的 anim-rise;只留 pill 內容切換用 |
| 2 | accent 使用過散(漸層按鈕多處、卡片圖示多彩) | ③accent 紀律 | 每頁一個實心 accent;圖示改灰階+選中態才上色 |
| 3 | focus-visible 全域缺落 — 鍵盤導航無環 | ④State 矩陣「明確缺漏」 | 全域 `:focus-visible` 內縮 2px 亮環(accent 亮色,offset -1px) |
| 4 | disabled 只有 opacity-40,未保文字對比 | ④(alpha 0.44 下限) | 統一 disabled:文字/框 alpha 0.44 + not-allowed |
| 5 | hover 各處自訂(hover:bg-white/10 / hover:bg-ink-850 混用) | ④hover=白 20% 覆蓋層 | 統一 hover `bg-white/[0.08]`→互動態 `[0.14]`(緊湊 UI 取下限),active `[0.2]` |
| 6 | 中文 Semibold 靠瀏覽器合成粗體(JhengHei 缺 600) | ①CJK 禁合成粗體 | 字型棧補 Noto Sans TC(打包 variable 字型)或 weight 階只用 400/700 |
| 7 | tracking 未分級(大字未負 tracking、小 label 未正 tracking) | ①tracking 表 | 11-12px +0.4px;17px −0.025em;20px+ −0.03em;eyebrow 11px/600/uppercase/+0.5px |
| 8 | pill 無內容 crossfade、無同心圓角 | ①Island 解剖 | 收合/展開:舊內容 90ms 出、新 120ms 延遲入;pill 內元素 radius = 外殼 − padding |
| 9 | 錄影流程焦慮項全缺(倒數/暫停凍結/即時預覽/重錄上段) | ②焦慮清單 | 見施工清單 P0-2 |
| 10 | 主視窗卡片陰影無亮環、input 無凹槽感 | ④shadow/inset | shadow 統一帶 `0 0 0 1px white/8`;input `inset 0 1px 0 black/24` |

## 精緻度施工清單

### P0 — Token 地基(半天,全域見效)
1. **Motion token**:`--dur-fast:100ms; --dur-base:200ms; --dur-overlay:300ms` + 三條 easing(hover `cubic-bezier(.25,.1,.25,1)` / 進場 `(.1,.9,.2,1)` / 退場 `(.9,.1,1,.2)`)+ `prefers-reduced-motion` 全域折為 1ms
2. **Focus ring 全域**:`:focus-visible { outline:2px solid var(--accent-300); outline-offset:-1px }`
3. **Surface/hairline token**:hairline `white/12`、hover 邊 `white/18`、浮層陰影帶亮環;移除 overlay 根動畫
4. **Accent 紀律掃描**:每頁最多一個實心 accent 區塊;按鈕 hover 改白 8%/14%/20% 三態

### P1 — 浮層精緻化
5. **Pill morph 升級**:開合分離阻尼(CSS 雙 cubic-bezier:開 `(.3,1.25,.35,1)` 500ms / 合 `(.3,.7,.25,1)` 380ms)+ 內容 crossfade(舊 90ms/新延遲 120ms)+ 同心圓角;長遠改 rAF 彈簧積分器(retarget)
6. **字型**:打包 Noto Sans TC variable(@fontsource-variable/noto-sans-tc,子集化中文),字型棧置於 JhengHei 前 — 根治合成粗體
7. **Tracking 分級** + eyebrow label(11px/600/uppercase/+0.5px)套設定區塊標題
8. **精度降級**:pill 關鍵詞寬度不足時降級為「下一句」前 4 字,不出現 …

### P1 — 錄影體驗(②的 10 模式,我們的錄影提詞升級)
9. **錄前**:3-2-1 倒數(可關)+ 攝影機鏡像預覽 + mic 綠色音量條(借 Zoom pre-join;校準頁已有素材)
10. **錄中**:暫停/續錄(MediaRecorder.pause,計時凍結 + 「已暫停」浮水印)、每 5s chunk flush「已安全保存 X 分鐘」信心指示(Riverside 教訓的反面:本機永不丟檔)
11. **錄後**:Blob URL 即時預覽 + 重新命名 + 「開啟所在資料夾」(`shell.showItemInFolder`)+ Whisper 轉錄進度;長期:分段 clip bar + 重錄上段(Tella)
12. **不抄清單**:終段上傳黑箱(Riverside)、AI 眼神矯正/美顏(違背本機隱私)、把提詞器埋進深選單(Descript 教訓)

### P2 — 進階質感
13. Liquid Glass 真折射:SVG `feImage+feDisplacementMap`(squircle 位移圖 scale 12–18)+ `backdrop-filter: url(#f)`,Chromium-only 需 engine 偵測 fallback;pill 加隨游標 specular
14. 玻璃 vibrancy 文字三級 alpha(100/72/52%)取代全域灰階 token
15. Toast 系統(400ms ease、4s 自動消失、hover 暫停、堆疊 scale 0.05 遞減)— 目前訊息散在各頁角落

## 來源精選
- ①Apple:boring.notch spring 原始碼 / WWDC23 Live Activities / WWDC25 Meet Liquid Glass / kube.io SVG 折射 / HIG Typography gist 實測 tracking
- ②錄影:Descript teleprompter / Tella clips+re-record / Loom stop-即分享 / Riverside progressive upload / OBS snapping / Zoom pre-join / Teleprompter Pro timed scrolling
- ③精緻度:Emil Kowalski 動效七招 / Rauno invisible details / awesome-design-md(Linear/Raycast/Slack/Warp 逆向 DESIGN.md)/ Linear Method / Raycast design guidelines / Superhuman <100ms
- ④Token:Primer primitives(實測 shadow/focus/border 原始值)/ Radix Colors 12 階語意 / Polaris whiteAlpha / Fluent 2 tokens / Atlassian / WCAG 2.5.8 + 1.4.11
