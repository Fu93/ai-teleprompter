import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // scripts/**/*.test.mjs:稽核輔助函式的負向驗證(例:corner-scan 的角落幾何
    // 斷言要能真的在「方角」缺陷上變紅)。它們用合成像素直接驅動,不啟動 Electron。
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    reporters: 'default'
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  }
})
