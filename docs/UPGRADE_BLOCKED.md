# 被上游阻塞的依賴升級(2026-10-05 查證)

## 為什麼有這份文件

`npm outdated` 每次都會列出這些落後的套件,但那個列表**不含原因** ——
看不出「能不能升」和「為什麼沒升」的差別。本文件記錄查證過的結果,
省下下一次重查的成本,並且寫清楚**什麼條件改變時可以升**。

## 目前的兩筆(都不是本專案的問題)

| 想升的 | 目前 | 目標 | 阻塞者 | 何時可以升 |
|---|---|---|---|---|
| eslint | `^9.39.5` | `^10.12.0` | `eslint-plugin-react@7.37.5`(**最新**)的 peer 是 `^3 \|\| … \|\| ^9.7`,不含 10 | 該套件發新版把 peer 上限提到 `^10` |
| vite | `^7.3.6` | `^8.3.2` | `electron-vite@5.0.0`(**最新**)的 peer 是 `^5 \|\| ^6 \|\| ^7`,不含 8 | electron-vite 支援 vite 8 的版本發布 |

查證方式:

```bash
npm view eslint-plugin-react version peerDependencies
npm view electron-vite version peerDependencies
```

## 為什麼沒有用 `--force` 硬推

`--force` 會讓 npm 接受一個標記為「可能壞掉」的解析。而這個專案的完整驗證
(e2e 58 支 + 6 支 UI 稽核)**全部需要真 Electron 才能跑** —— 也就是說,
接受一個壞掉的解析之後,唯一能確認它壞沒壞的方法成本很高,而已經升級的
代價(排查 vite 8 / eslint 10 的相容性)遠大於等待的成本。

**這兩筆都是等上游,不是等我們。** 等上游解封的期間,成本是零。

曾經有第三筆(electron,被 `EBUSY` 阻塞),而它與前兩筆性質不同 —— 那是**環境**問題
(上一輪驗證沒關掉 Electron),不是上游沒做。升級完成後已移到「已完成的升級」。
這一筆值得留下來的原因:`EBUSY` 這個字在「套件升級失敗」裡看起來像依賴問題,
實際上是自己的上一輪沒收拾乾淨。**先確認是誰鎖住檔案,再懷疑 npm。**

## TypeScript 7:刻意不排入這個清單

`typescript@7.0.2` 是大版本,而且 `typescript-eslint@8.71.0` 的 peer 是
`typescript: '>=4.8.4 <6.1.0'` —— **TS 7 會直接撞上它的 peer 上限**。

但這筆與上面三筆性質不同:

- 上面三筆是「上游沒做」,等就好。
- 這筆是「升了之後,型別層的驗證工具鏈(typescript-eslint)會不支援」,
  而 typecheck 正是這個專案三道閘門之一。風險在本專案這邊,不在上游。

而且效能收益有限:這個專案的 `npm run typecheck` 三個 tsconfig 跑完只要幾秒。
**收益小於風險,不建議升。** 真的需要新語法特性時再說。

## 已完成的升級(留個對照)

| 套件 | 升級 | 原因 |
|---|---|---|
| `lucide-react` | 1.48 → 1.52 | patch,無風險 |
| `vitest` | 5.0.2 → 5.0.3 | patch,無風險 |
| `http-cache-semantics` | 4.2.0 → 4.2.1 | 用 `overrides` 強制。`npm audit` 從 1 個 high 降到 0 |
| `electron` | 44.4.5 → 44.5.1 | 前兩次 `EBUSY` 的真因**不是** npm 或防毒軟體,是被中止的稽核留在背景的 Electron 實例鎖住 `node_modules/electron/dist`。實例清空後一次就成功 |

## 建議:加一個每週檢查

上面兩筆 peer 上限是可以用 `npm view` 查到的,值得放成一個 CI 排程步驟
(或 Dependabot 的 `peer` 支援),讓「上游解封了」變成一則通知而不是一次記憶。
腳本 gist(概念):

```bash
for p in eslint-plugin-react electron-vite; do
  echo "=== $p"
  npm view "$p" version peerDependencies
done
# 與 docs/UPGRADE_BLOCKED.md 的表比對,不一致就提醒更新
```
