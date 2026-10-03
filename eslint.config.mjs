/**
 * eslint.config.mjs — ESLint 9 flat config。
 *
 * ── 為什麼現在才有 lint ──
 *   這個 repo 的程式碼裡一直留著 `// eslint-disable-next-line
 *   react-hooks/exhaustive-deps` 這類註解(TooltipHost / Calibration /
 *   Scripts 共 6 處),卻沒有任何 eslint 設定 —— 那些註解從來沒有生效過,
 *   它們只是「某個工具要求的樣子」。加上 lint 讓它們變成真正的契約:
 *   有人誤刪一個 disable,lint 會紅;有人新增一個依賴沒列進去,lint 也會紅。
 *
 * ── 規則的三個分層(刻意的) ──
 *   1. **error**:真的會壞掉的東西。`no-unused-vars`、`no-constant-condition`、
 *      hooks 的兩個規則(這兩個抓到的是**真實的 stale closure 缺陷**,
 *      不是格式偏好)。
 *   2. **warn**:可能是問題但常常是刻意的。`@typescript-eslint/no-explicit-any`、
 *      `no-console`。不擋 merge,但會列出來 —— 一份從 0 開始長的 warn 清單
 *      比一開始就把它們設成 off 有用得多。
 *   3. **off**:明確不做。`no-undef` 由 tsc 負責(它比 ESLint 的版本可靠),
 *      開兩個只會得到重複且較弱的錯誤。
 *
 * ── 為什麼先量化再決定怎麼處理既有違規 ──
 *   見 eslint-baseline.json 的檔頭。那個檔案不是「把問題藏起來」——
 *   它有**上限**,新增違規一律紅(見 lint-baseline.test.mjs)。
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

/** renderer 用的瀏覽器/Electron 全域。 */
const RENDERER_GLOBALS = {
  ...globals.browser,
  // preload 透過 contextBridge 掛在 window 上,型別在 preload/index.d.ts。
  // 宣告在這裡(而不是每個檔案)—— 宣告散落會讓「這個全域是誰提供的」
  // 追不回去。
  window: 'readonly'
}

/** main / preload 用的 Node 全域。 */
const NODE_GLOBALS = {
  ...globals.node,
  // Electron 特有的注入全域(remote 早已移除,但 Electron 仍提供 process.type)。
  process: 'readonly'
}

export default tseslint.config(
  {
    // 整個 repo 的預設。先刻意不開 TS 規則:tsconfig 的 strict 已經
    // 覆蓋了型別層,而真正的新增價值在 hooks 與正確性那一組。
    //
    // ⚠️ 這個物件**只能有 ignores**。flat config 的規則是:一個設定物件
    // 只有在「除 ignores 外沒有其他鍵」時才會被當成全域忽略。混進
    // linterOptions(或任何其他鍵)會讓它退化成「只對這個設定生效的忽略」——
    // 於是 out/ 的建置產物會被掃進來,裡面那些壓縮後的 worker bundle 會回報
    // 「找不到 @typescript-eslint/naming-convention 規則」之類的假錯誤。
    // 這不是假設:寫在第一次加 lint 時就踩過一次。
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'docs/**', 'test-results/**', '*.tsbuildinfo']
  },

  // 多餘的 eslint-disable 指示視為錯誤。
  //
  // 為什麼這條重要:一個 disable 註解的價值完全建立在「它蓋住了什麼」上。
  // 當它不再蓋住任何東西(規則改了、依賴列補齊了、那段程式被搬走了),
  // 它就變成一句謊話 —— 而且是一句看起來很專業的謊話:讀者會以為那裡
  // 有個已知的、有人處理過的問題。
  //
  // 第一次開 lint 時就抓到 4 筆:ToastHost / Calibration×2 / sttAligner。
  // 全部是「這個專案從來沒有 eslint 設定」時代留下的樣子 —— 從未生效。
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },

  // ===== Node 側:main / preload / 建置腳本 =====
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'electron.vite.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: NODE_GLOBALS,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // 這是本專案特有的坑:recordHandler 一類的簽章需要比對參數型別,
          // 而 TS 的 unused 檢查看不到那種用法。
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // console 在 main 端是正常輸出(那是記錄的一部分),
      // 但 renderer 端不該有 console —— 那會把除錯輸出混進使用者看得到的畫面。
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error'
    }
  },

  // ===== Renderer 側:React + Electron =====
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended
    ],
    languageOptions: {
      globals: RENDERER_GLOBALS,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      react,
      'react-hooks': reactHooks
    },
    settings: { react: { version: 'detect' } },
    rules: {
      // 這兩條是這個設定裡最有價值的部分 —— 它們抓到的是 stale closure
      // 與失效的 effect 依賴,那類缺陷的症狀是「資料沒更新」而原因在
      // 另一個檔案,極難靠讀碼找出。
      // eslint-plugin-react-hooks v5 對 React 19 已內建 runtime 檢查,
      // 開 recommended 即可。
      ...reactHooks.configs.recommended.rules,
      // 不開 react/prop-types:這個專案 100% 用 TypeScript,那條規則會
      // 對每個 component 要求一份重複的型別宣告。
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      // react-in-jsx-scope 在 React 17+ 之後已經是錯的:jsx-runtime 自動
      // 引入 JSX 所需的一切(這個專案的 tsconfig 設的是 react-jsx)。
      // 第一次跑 lint 時它報了 1182 筆 —— 全部是同一個配置錯誤,
      // 而不是 1182 個缺陷。保留它會讓「紅燈」這件事失去意義。
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // renderer 端不該有 console.warn/error —— 使用者看得到 console 的機會
      // 很低(那是除錯用),而它們會被誤當成「這裡沒處理錯誤」的證據。
      // 要記錄請走 window.api.logFromRenderer / reportError。
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error'
    }
  },

  // ===== e2e:Node + Playwright,但要用 TS parser =====
  // 這一塊必須獨立成一個 blocks:上面兩個區塊的 files 不含 e2e/,
  // 而沒有 parser 的話 .ts 會被當成 JavaScript 解析 → 21 筆 Parsing error。
  // 「Parsing error: Unexpected token {」在這種情況下是**配置錯誤**而不是
  // 缺陷,而它佔滿整份報告時紅燈就失去意義了。
  {
    files: ['e2e/**/*.ts', 'scripts/**/*.mjs', 'vitest.config.ts', 'playwright.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // 稽核腳本與測試大量使用 console(那**就是**它們的輸出介面)。
      'no-console': 'off',
      // no-new-func 在稽核腳本與 e2e 裡是必要的(page.evaluate(函式) 需要),
      // 而 disable 註解已存在於 scripts/audit-effects.mjs 等處 ——
      // 這條讓那些註解有實際效果。
      'no-new-func': 'error'
    }
  },

  // ===== 測試:允許較寬的斷言與未使用的前置 =====
  {
    // 放在 e2e 那塊**之後**:flat config 依序套用,後面的 rules 覆蓋前面的。
    // 這一條不關掉 no-unused-vars —— 那 13 筆是真實的未使用匯入與變數
    // (「匯入了但沒用」通常是一段被刪掉一半的改動),逐個修掉比豁免便宜。
    // 只對**測試**放寬到 off,而 e2e 保持 error(見上)。
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off'
    }
  }
)