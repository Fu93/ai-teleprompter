/**
 * 量測頁面的 Electron 主行程(給 measure-transcript-rerender-dom.mjs 載入)。
 *
 * 為什麼不直接用 playwright 的 chromium:這個專案的 Playwright 沒有安裝
 * 瀏覽器(它的 e2e 全部走 Electron),而 Electron 的 Chromium 就是使用者真正
 * 在跑的環境 —— 用它量出來的數字才對得上這個產品。
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await win.loadFile(path.join(__dirname, 'transcript-bench.html'))
  // 量測主程式在這個 promise 裡等頁面回報
  const result = await win.webContents.executeJavaScript('window.__run()')
  process.stdout.write('__RESULT__' + JSON.stringify(result) + '\n')
  app.quit()
})

app.on('window-all-closed', () => app.quit())
