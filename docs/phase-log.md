# 階段紀錄

## S3a-1（新專案骨架）

- 複製 `ai-era-education-live`（不含 node_modules、.wrangler、.dev.vars、舊 `public/deck/` 與 `scripts/sync-deck.mjs`）。
- 移除所有 `sync-deck`、`/deck/`、`contentWindow` 引用；live 頁改為佔位狀態。
- Worker 名稱與 `/api/health` 的 app 名稱改為 `ptt-teach`；`wrangler.toml` 移除 `GOOGLE_CLIENT_ID`、`ADMIN_EMAILS`，加 `keep_vars = true`。
- 管理者信箱改為 `admin@example.test`；本機開發連接埠改為 8801；review-check 改用 8811 與本專案 node_modules 的 wrangler。
- `package.json` 加 devDependency `wrangler` 4.147.0（尚未安裝，由主 session 在本機安裝）。
- 納入 S2 產出：`docs/deck-contract.md`、`schema/deck.schema.json`、`examples/ai-era-education.deck.json`。
