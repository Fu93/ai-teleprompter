/**
 * manifest.d.mts — e2e/manifest.mjs 的型別宣告。
 *
 * 為什麼需要這份檔案:manifest 必須是 .mjs(package.json 的 script 與
 * release-gate.mjs 都是 .mjs,而 vitest 的 include 只收 .test.ts)。
 * 它的代價是 **tsc 沒有型別** —— 沒有這份宣告時,
 * e2eManifest.test.ts 會得到「implicitly has an 'any' type」,
 * 而那支測試正是要確保測試清單不漂移的那一支。讓它自己編譯不過是不能接受的。
 *
 * 這份宣告要跟著 manifest.mjs 一起維護:少宣告一個匯出,tsc 就會紅,
 * 所以兩者不同步是**會被發現**的(這正是把它寫成 .d.mts 而不是 `any` 的理由)。
 */

export type AdvisorySpec = { file: string; reason: string }

export const BLOCKING_SPECS: string[]
export const ADVISORY_SPECS: AdvisorySpec[]
export const ALL_SPECS: string[]

export function describeE2E(): {
  blocking: string[]
  advisory: AdvisorySpec[]
}
export function blockingArgs(): string[]
export function advisoryArgs(): string[]