/**
 * scriptImport.test.ts — 講稿匯入的大小上限與它的人話訊息。
 *
 * 為什麼值得測:上限本身是兩行常數,但**訊息**才是這個功能的一半。
 * 「匯入失敗」對剛按了檔案選擇框的使用者毫無幫助;訊息必須指出「你可能選錯檔案」。
 */
import { describe, it, expect } from 'vitest'
import { MAX_SCRIPT_IMPORT_BYTES, describeImportTooLarge } from '../scriptImport'

const MB = 1024 * 1024

describe('describeImportTooLarge', () => {
  it('在上限之內可以匯入(回 null)', () => {
    expect(describeImportTooLarge(0)).toBeNull()
    expect(describeImportTooLarge(120 * 1024)).toBeNull()
    expect(describeImportTooLarge(MAX_SCRIPT_IMPORT_BYTES)).toBeNull()
  })

  it('超過上限要擋下,而且說得出大小與上限(使用者要能自己判斷是不是選錯檔)', () => {
    const msg = describeImportTooLarge(800 * MB)
    expect(msg).not.toBeNull()
    expect(msg).toContain('800.0 MB')
    expect(msg).toContain('2.0 MB')
  })

  it('訊息指向「可能選錯檔案」,而不是只說失敗', () => {
    expect(describeImportTooLarge(400 * MB)).toContain('選錯')
  })

  it('拿不到大小時不擋(寧可讓它試,也不要擋掉一份正常的講稿)', () => {
    expect(describeImportTooLarge(undefined)).toBeNull()
    expect(describeImportTooLarge(Number.NaN)).toBeNull()
  })

  it('負向驗證:拿掉上限判斷,「超過上限要擋下」當場變紅', () => {
    // 這一條不是測程式碼,是提醒下一個改這裡的人:
    // 沒有上限時,選到影片的使用者只會看到 App 沒反應。
    expect(describeImportTooLarge(999 * MB)).not.toBeNull()
  })
})