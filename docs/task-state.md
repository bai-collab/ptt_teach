# 任務狀態

## 目前狀態

- 目前切片：**S3a-1（新專案骨架）已完成**。
- 下一切片：**S3a-2（開發登入只限迴環主機）**，安全敏感，需另行審查。

## 切片進度

| 切片 | 內容 | 狀態 |
|---|---|---|
| S3a-1 | 由 ai-era-education-live 複製骨架、移除舊動畫路徑、改名 ptt-teach、去真實信箱與 Client ID | 已完成（待主 session 驗收：安裝 wrangler 後跑 review-check） |
| S3a-2 | `DEV_LOGIN` 只限迴環主機 | 未執行 |
| S3b | deck 驗證模組、伺服器端改由 deck 快照驗證、前端由 deck.json 渲染 | 未執行 |
| S3c | 簡報庫（R2）與管理者上傳 | 未執行 |
| S3d | 簡報主機、隔離載入、建場選簡報 | 未執行 |

## 過渡狀態（到 S3d-B 前維持）

- `public/live.html` 的 iframe 為 `about:blank`，舞台顯示「動畫尚未接上」。
- `public/live.js` 沒有動畫時間同步，也沒有任何 `contentWindow` 或 postMessage 程式。
- 播放按鈕停用；翻頁、討論、標註照常。
