import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/**
 * logging.ts — 產品化基礎:崩潰與未捕捉例外的落盤日誌
 *
 * 公開發佈後使用者遇到的問題看不見,唯一回饋來源是本機日誌。
 * 寫在 userData/logs/main.log,輪替保留 3 檔(依大小切,不是依天——
 * 崩潰可能一分鐘內塞爆,切檔看大小才可靠)。
 */

const LOG_DIR = (): string => join(app.getPath('userData'), 'logs')
const MAX_BYTES = 1_000_000 // 1MB
const KEEP = 3

function rotateIfLarge(): void {
  try {
    const p = logFile()
    if (!existsSync(p) || statSync(p).size < MAX_BYTES) return
    // main.log → main.1.log → main.2.log(最舊刪除)
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = join(LOG_DIR(), `main.${i}.log`)
      const to = join(LOG_DIR(), `main.${i + 1}.log`)
      if (existsSync(from)) {
        if (i + 1 > KEEP) unlinkSync(from)
        else {
          if (existsSync(to)) unlinkSync(to)
          try {
            const fs = require('fs') as typeof import('fs')
            fs.renameSync(from, to)
          } catch {
            /* 忽略:輪替失敗不影響本體 */
          }
        }
      }
    }
    unlinkSync(p)
  } catch {
    /* 忽略 */
  }
}

export function logFile(): string {
  return join(LOG_DIR(), 'main.log')
}

export function initLogging(): void {
  try {
    mkdirSync(LOG_DIR(), { recursive: true })
  } catch {
    return // 磁碟不可寫:靜默放棄日誌,不擋啟動
  }

  const write = (level: string, msg: string): void => {
    try {
      rotateIfLarge()
      appendFileSync(logFile(), `[${new Date().toISOString()}] [${level}] ${msg}\n`, 'utf-8')
    } catch {
      /* 忽略 */
    }
  }

  process.on('uncaughtException', (err) => {
    write('FATAL', `uncaughtException: ${err.stack ?? String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    write('ERROR', `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
  })

  write('INFO', `--- app start v${app.getVersion()} (${process.platform}) ---`)
}

/** main 進程的一般訊息(啟動宣告、模式切換)——renderer 前綴留給 logFromRenderer */
export function logMain(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  try {
    rotateIfLarge()
    appendFileSync(logFile(), `[${new Date().toISOString()}] [${level}] ${message}\n`, 'utf-8')
  } catch {
    /* 忽略 */
  }
}

/** renderer 經 IPC 落同一份檔案(前端錯誤也要能看到) */
export function logFromRenderer(level: 'ERROR' | 'WARN' | 'INFO', message: string): void {
  try {
    rotateIfLarge()
    appendFileSync(logFile(), `[${new Date().toISOString()}] [renderer:${level}] ${message}\n`, 'utf-8')
  } catch {
    /* 忽略 */
  }
}

/** 設定頁「開啟記錄資料夾」用 */
export function logDir(): string {
  return LOG_DIR()
}

/** 測試/診斷用:列出目前日誌檔 */
export function listLogFiles(): string[] {
  try {
    return readdirSync(LOG_DIR()).filter((f) => f.endsWith('.log')).sort()
  } catch {
    return []
  }
}
