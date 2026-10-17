# 交接

- 現況：S3a-1（新專案骨架）已完成，已有一個本機 commit；未建立 GitHub repo、未 push。
- 接手前先做：在專案目錄執行 `npm install`（安裝 wrangler 4.147.0），再跑 `node scripts/review-check.mjs`（8811 埠）確認 smoke-ws／smoke-auth 與 `wrangler deploy --dry-run` 通過。
- 下一步：**S3a-2**（`src/worker.js` 的 dev-login 分支與 `src/auth.js` 相關檢查，限制 `DEV_LOGIN` 只在迴環主機有效；安全敏感）。
- 注意：動畫尚未接上；與動畫時間同步有關的 UI 測試延到 S3d-C。
- 秘密規則：真實 Client ID、管理者信箱不進版控，見 `AGENTS.md`。
