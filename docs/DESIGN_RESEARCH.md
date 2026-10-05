# 設計研究綜合報告(2026-09-27)

> 兩路子代理研究:競品標杆(Cluely 2026 現況、Final Round AI、LockedIn、Sensei、Yoodli、Poised、PromptSmart、廣播級提示機)+ 設計方法(Apple Liquid Glass/HIG、動效配方、提詞可讀性科學、Windows 玻璃坑)。本文件只留**可執行結論**。

## 先說好消息:三個既有決策被研究背書

1. **貼鏡模式的方向正確**:觀眾感知「看鏡頭」的容許錐角約 ±5°(Kluttz 2009 / Gao 2025),最佳注視點是鏡頭下方約 2°(鼻樑)。幾何換算:文字帶距鏡頭 4cm、臉距 50cm ≈ 4.6° — 剛好安全。側邊欄式 overlay 會明顯「看畫面外」。
2. **會後延遲回饋是對的**:動作學習研究一致結論 — 即時回饋提升當場表現但造成依賴,延遲、遞減的回饋才產生長期進步(Maas 2008;Weir-Mayta)。我們「會中只留 Alt+P、診斷放會後」正是文獻推薦的排程。Poised(純即時說教)2026/10 終止服務是反面教材。
3. **本地優先是賣點**:PromptSmart+ 已證明離線 ASR 可信;Cluely 的 Trustpilot 1.8 主要來自帳單黑箱與幻覺 — 誠信與本地資料在這個品類就是差異化。

## 競品矩陣(摘要)

| 產品 | 形態 | 值得偷 | 弱點(我們要防) |
|---|---|---|---|
| Cluely | 半透明 pill overlay,「跟隨目光」定位,Liquid Glass 質感 | GPU 級擷取隱形($149 檔)、單一快捷鍵肌肉記憶 | 實測延遲 5–10s、幻覺、帳單黑箱 |
| Final Round AI | 全卡片 overlay + 面試生態 | STAR 結構化答案 | 廣告價與實價差 3–6 倍、延遲 |
| LockedIn AI | Desktop stealth | 偽裝行程名 + 全域熱鍵 | 擴充版分享中可見 |
| Yoodli | 會後 dashboard | 私密評分卡:填充詞/語速/眼神%/停頓 | 無即時能力(練習向) |
| PromptSmart | 廣播級提示機 | **VoiceTrack:跟隨語音、停頓即停、脫稿即停** | 辨識可靠度是最大投訴 |
| Poised | 通話中微提醒 | 邊講邊輕推的先驅 | 2026/10 關站 — 純即時說教撐不起產品 |

三大類別共同抱怨(設計防禦):延遲+幻覺、訂閱陷阱、偵測焦慮。

## 優先升級清單(P0 → P2)

### P0-1 貼鏡模式升級為「凝視錨點」(研究支持度最高) ✅ 已完成(2026-10-05)
- 磁吸對齊 webcam:`enumerateDevices` 列出攝影機 + 一次性拖放校正 → `window.moveTo()` 停靠鏡頭正下方,文字帶頂緣距鏡頭中心 ≤4cm
- 設定中**量化顯示偏移角度**(≈ arctan(距離÷臉距)),讓「眼神自然」從感覺變數字
- 文字帶行寬鎖 30–34 字/行(W3C 中文排版甜蜜點),只顯示當前句 ±1 句

> **實施記錄**:貼鏡工具列 `◎ 鎖定`/`◉ 鏡頭` + 進貼鏡自動停靠
> (`overlay.gazeAnchor`,決策在 `src/main/gaze.ts`);設定頁「凝視錨點」狀態列
> 顯示 cm 與度數(96dpi 假設,與 `visualAngleDeg` 同一套);`LENS_SIZE`
> 420→640 →(640−32)/19 ≈ 32 字/行,LensSurface phrase 分支改為
> 上一句/當前句/下一句三行。限制:「鏡頭≈螢幕上緣」是假設(與角落吸附同一條
> 前提);±1 只套 phrase 分支。驗收與負向設計見 CHANGELOG 同日條目。

### P0-2 語音跟隨捲動強化(PromptSmart VoiceTrack 的可靠版)
- 我們已有 Whisper 本地跟隨;補上:**停頓即凍結捲動**、**跳回關鍵詞**(重複唸上一句時自動回捲)、**滾輪手動微調永不失效**(把對手最大弱點變賣點)

### P0-3 pill 漸進揭露 + 可中斷 spring morph
- pill 顯示「下一個關鍵詞 + 進度」(不只進度),Alt+P 展開要點卡 — Cluely 的肌肉記憶公式
- morph 配方:容器 spring `cubic-bezier(0.32, 0.72, 0, 1)` 0.35–0.5s;舊內容 100ms fade-out、新內容延遲 150ms fade + scale 0.9→1;morph 期間不動 backdrop-filter(保 60fps)、動畫可中斷重定目標

### P1-1 排版規格套用(廣播級預設)
| 項目 | 套用值 |
|---|---|
| 中文語速基準 | 240 字/分(≈150 WPM;校準模組已支援,改為滾動速度預設單位) |
| 每行字數 | phrase 斷行目標 30–35 字 |
| 行高 | 1.7–2.0(逐句模式已是 1.7 ✓) |
| 字重 | glancing 場景 SemiBold 500–600 |
| 閱讀性投影 | `text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.5)`(軟陰影比硬描邊自然) |

### P1-2 玻璃配方微調(Liquid Glass 對齊)
- `saturate(150%)` → **`saturate(180%)`**(blur 抽飽和必須補回)
- Specular 邊:`inset 0 1px 1px rgba(255,255,255,0.6), inset 0 -1px 1px rgba(255,255,255,0.2)`
- 進階(Chromium only):SVG `feTurbulence + feDisplacementMap` 真折射,`@supports` 偵測不到須用 engine 偵測 + fallback
- 深色階層:`#121212 → #1E1E28 → #28283A`,文字 87%/60%/38% 白

### P1-3 AI 建議出場動效
- 首 token 前骨架 shimmer;token 到達改**逐詞漸顯**(非逐字,防抖)+ 串游標
- 救援卡/摘要卡進出場用 P0-3 的 spring 配方

### P1-4 首次啟動 checklist + 空狀態 CTA
- Dashboard 常駐 3 步卡:匯入講稿 → 校準(鏡頭對齊+語速)→ 試跑 30 秒;完成打勾 reveal 下一項
- 所有空狀態回答三問(這是什麼/為何空/下一步)+ 單一主 CTA

### P2-1 「分享前模擬測試」按鈕(誠信差異化)
- 設定頁/浮層一鍵:開一個測試視窗顯示「螢幕擷取實際看到什麼」— 直接驗證隱形範圍,正面回應類別最大焦慮
- 明示不可見性的確切範圍(Windows 版本、何時失效)

### P2-2 玻璃效能守則(已部分符合)
- blur 半徑 ≤20px 原則(目前 24–32px,浮層面積小可接受;主視窗卡片 20px ✓)
- 不 animate backdrop-filter 本身;Reduce Transparency 系統設定時自動切實心

## 來源精選
- Cluely:cluely.com / tldv.io 誠實評測 / docs.cluely.com changelog
- 凝視科學:Gao et al. 2025 (arxiv 2404.17104) / Kluttz 2009(±5° 錐角)/ Mona Lisa effect
- 排版:W3C 中文排版需求(clreq)/ Atilgan 2020(每行 ≥13 字元)/ Caption Royale 2024
- 回饋排程:Maas et al. 2008 / Weir-Mayta(PMC8556735)
- 動效:WWDC Building Fluid Interfaces / NN/g Skeleton Screens / FlowToken
- Windows 玻璃:Electron custom-window-styles 文件 / pykeio/vibe / Inkdrop acrylic lag
