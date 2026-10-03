# scripts/attic — 一次性探針腳本

這些腳本是一次性調查(藥丸滑桿像素分析、材質/specular 探測、桌面截圖探針等)的
產物,任務完成後沒有再被引用:不在 package.json、不在 audit-all、不在 CI。
留在 scripts/ 根目錄會讓人以為它們有門禁保固 —— 沒有。它們不改、不跑也不影響
任何稽核;若未來要重啟某項調查,先重新檢查它引用的 DOM 錨點是否還存在。

| 腳本 | 原用途 |
|---|---|
| audit-slider.mjs | 藥丸大小滑桿的幾何稽核(後由 audit-deep 規則取代) |
| analyze-slider-pixels.mjs | 從截圖量滑桿像素位置 |
| analyze-specular.mjs | 玻璃 specular 高光分析 |
| probe-corners.mjs | 圓角/邊緣探測 |
| probe-desktop.mjs | 桌面層級截圖探針 |
| probe-material.mjs | Windows 材質(acrylic)探測 |
| probe-specular.mjs | specular CSS 變數探測 |
