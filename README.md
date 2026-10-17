# ptt_teach｜多簡報研習互動平台

研習者輸入 6 碼加入 → 跟隨講師或自由觀看 → 在討論頁留言、投票、手寫，所有人即時看到。在有頁面文字的頁上可以「問 AI」（S8 單頁問答，只回文字＋Markdown；見下方「單頁 AI 問答」）。

本專案由 `ai-era-education-live`（單一簡報的研習互動版）泛化而來，目標是讓管理者匯入多份簡報、講師建場時選簡報（見 `docs/deck-contract.md`）。

> **目前功能**：管理者可上傳多份簡報；講師建立場次時可選擇已完成上傳的簡報。研習畫面會在獨立簡報主機載入該簡報。

## 架構

```text
瀏覽器（public/）──HTTP──▶ Worker（src/worker.js）
     │                        ├─ POST /api/rooms        建場（Google 登入的講師，或 CREATE_SECRET）
     │                        ├─ GET  /api/rooms/:code  查詢場次
     │                        ├─ POST /api/rooms/:code/ask  單頁 AI 問答（NMKING；次數記在 Room）
     └──WebSocket────────────▶└─ /api/rooms/:code/ws ──▶ Room（Durable Object，一場一個）
                                                         ├─ 講師目前頁與播放狀態
                                                         ├─ 留言／投票／筆跡（SQLite）
                                                         └─ 7 天後 alarm 自動刪除
```

| 頁面 | 用途 |
|---|---|
| `/` | 研習者加入頁（可帶 `?code=`，方便做成 QR） |
| `/teacher.html` | **講師入口**：Google 登入 → 建立場次、我的場次、產生備援講師連結；管理者另有「講師名單」 |
| `/live.html?code=XXXXXX` | 研習畫面；登入的場次擁有者自動是講師，備援講師連結另帶 `#key=…` |
| `/create.html` | 備援：以建場密語建場（只有設定了 `CREATE_SECRET` 才能用） |

## 設定（Google 登入、管理者）

本 repo **不含任何真實的 Google 用戶端 ID 或管理者信箱**。`wrangler.toml` 的 `[vars]` 只有 `ENVIRONMENT`，並設定 `keep_vars = true`，所以部署時不會洗掉你在 Cloudflare 後台設定的變數。

| 變數 | 用途 | 本機開發 | 部署 |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID（網頁應用程式） | 寫在 `.dev.vars` | Cloudflare 後台 Variables |
| `ADMIN_EMAILS` | 管理者 Gmail，逗號分隔；管理者可在網頁維護講師名單 | 寫在 `.dev.vars` | Cloudflare 後台 Variables |
| `CREATE_SECRET` | 選用的備援建場密語（不設定就只能用 Google 登入建場） | 寫在 `.dev.vars` | `wrangler secret put CREATE_SECRET`（機密） |
| `NMKING_API_KEY` | 單頁 AI 問答的金鑰（不設定時「問 AI」回 503） | 寫在 `.dev.vars` | `wrangler secret put NMKING_API_KEY`（機密） |
| `NMKING_MODEL` | 選填，AI 模型；預設 `openai/gpt-5.6-luna` | 寫在 `.dev.vars` | Cloudflare 後台 Variables |

範本見 `.dev.vars.example`；`.dev.vars` 已被 git 忽略，**不要 commit**。

Google Cloud 設定：建立 OAuth 用戶端 ID（網頁應用程式）。「已授權的 JavaScript 來源」填部署網址與本機測試網址（`http://localhost:8801`）。不需要重新導向 URI。同意畫面只用到 email／profile 基本範圍。

## 單頁 AI 問答（S8）

研習畫面底部的「問 AI」只在 deck.json 該頁有 `text` 時出現。研習者輸入問題（1–300 字）後，Worker 把**這一頁的文字**與問題送給 NMKING（`https://ai.nmking.io/v1/responses`），請模型以該頁為主軸解釋：頁面沒定義的詞語要結合頁面脈絡與一般知識講清楚，不只回「沒有提到」；只有問題與本頁主題完全無關時才請研習者回到本頁。繁體中文 200 字內，不捏造頁面沒有的數據或來源。

- 回答只當文字顯示：前端以 DOM 文字節點組出極簡 Markdown（段落、粗體、清單、行內程式碼），不經 `innerHTML`。
- 次數上限：每位研習者每分鐘 3 次、每場總共 300 次，超過回 429；計數存在該場的 Room DO，結束場次時一併刪除。
- 金鑰設定：管理者在講師頁「AI 問答設定」輸入 NMKING 金鑰與（選填）模型，存在 Auth DO；網頁設定優先於環境變數 `NMKING_API_KEY`／`NMKING_MODEL`，清除後退回環境變數。任何 API 都不回傳金鑰本身，只回是否已設定、來源與末 4 碼；寫入與清除需管理者登入且 `Origin` 等於主站。
- 必須從主站送出（`Origin` 必須等於主站），否則 403；沒有設定 `NMKING_API_KEY` 時回 503；上游逾時 20 秒回 504。
- Worker log 只記狀態碼、輸出 token 數與耗時，不記提問、回答與金鑰；問題與回答也不存進資料庫。
- 頁面文字來源：動畫畫面上的字畫在 SVG 裡，AI 看不到；用 `node scripts/extract-deck-text.mjs <簡報資料夾> --out <新資料夾> --version <新版本號>` 以無頭 Chrome 逐段取樣畫面文字＋字幕，寫成新版 deck.json（create-only，不改原簡報），再以新版本上傳、重新建場。
- 本機測試：`node scripts/smoke-ask.mjs`（自己啟動埠 8851、8853 的 wrangler 與 8852 的假 NMKING，測完只關自己的程序）。

## 講師登入（Google，名單制）

```text
講師按「用 Google 登入」→ Worker 驗證 ID token（Google 簽章、aud＝本服務、未過期、信箱已驗證）
  → 在講師名單（或 ADMIN_EMAILS）上？ 否 → 拒絕
  → 是 → 發 12 小時 HttpOnly 登入 cookie（簽章金鑰由 Auth DO 自動產生）
管理者（ADMIN_EMAILS）在 /teacher.html 增刪講師 Gmail；移除後對方登入立即失效。
```

## 管理者上傳簡報與講師建場

1. 管理者登入 `/teacher.html`，在「簡報庫」選擇並上傳 `deck.zip`。上傳完成且狀態為「可用」後，講師才能選用。
2. 講師登入同一頁，在「建立新場次」的「選擇簡報」選一份簡報，再按「建立新場次」。建立後把加入連結提供給研習者。
3. 選單只列出狀態為 `ready` 的簡報。若保留「內建範例（無動畫檔）」，場次不會載入簡報檔案；要播放動畫或簡報頁面，請選一份已上傳的簡報。

## 權限

| 能力 | 講師 | 研習者 |
|---|---|---|
| 翻頁（跟隨的人同步） | ✓ | 只影響自己（自由觀看） |
| 留言、投票、手寫 | ✓ | ✓（只在討論頁） |
| 刪除留言／收回筆跡 | 全部 | 只限自己 |
| 置頂留言、清除筆跡、重設投票、結束並刪除 | ✓ | – |
| 看研習者名單（跟隨／自由、所在頁） | ✓ | –（加入頁已告知講師看得到） |
| 看投票者、筆跡作者 | ✓（「顯示作者」） | –（研習者端資料不含作者） |

限制：每場 200 連線；留言 ≤100 字、每人 3 秒 1 則；每頁留言 ≤400、筆跡 ≤1500；單筆 ≤400 點。

## 本機開發

需要 Node 22+。第一次先安裝相依套件（會安裝 `package.json` 指定的 wrangler 4.147.0）：

```bash
npm install
```

本機主站使用 `http://localhost:8801`，簡報主機使用 `http://127.0.0.1:8802`。請用這兩個不同的主機名稱開啟；若主站也用 `127.0.0.1`，簡報載入會被拒絕。

Windows 最簡單：雙擊 `start-dev.bat`（自動產生本機 `.dev.vars`、啟動主站並開啟講師入口）。使用簡報庫時，也要另外啟動簡報主機，見下方雙終端步驟。

其他環境：

```bash
cp .dev.vars.example .dev.vars        # 換成你自己的值
npm run check                          # 語法檢查＋wrangler deploy --dry-run
npm run dev                            # http://localhost:8801
CREATE_SECRET=<.dev.vars 的值> npm run smoke   # 另開終端：模擬講師＋研習者檢查
```

要在本機使用簡報庫，需在兩個 PowerShell 終端啟動主站與簡報主機；兩邊設定相同的 `WRANGLER_REGISTRY_PATH`，並共用 `--persist-to`：

```powershell
# 終端一：主站
$env:WRANGLER_REGISTRY_PATH = Join-Path (Get-Location) ".wrangler\registry-local"
npm run dev -- --ip 127.0.0.1 --port 8801 --persist-to .wrangler/local

# 終端二：簡報主機（在另一終端重新設定相同環境變數）
$env:WRANGLER_REGISTRY_PATH = Join-Path (Get-Location) ".wrangler\registry-local"
npx wrangler dev -c deck-host/wrangler.toml --ip 127.0.0.1 --port 8802 --persist-to .wrangler/local --var ENVIRONMENT:development --var MAIN_ORIGIN:http://localhost:8801
```

瀏覽器請以 `http://localhost:8801/teacher.html` 開主站；簡報主機使用 `http://127.0.0.1:8802`。同一場研習的主站與簡報主機若使用相同主機名稱，簡報會被拒絕載入。簡報主機不讀專案根目錄的 `.dev.vars`，所以指令用 `--var` 傳入開發模式與主站 origin：簡報主機的 CSP `frame-ancestors` 只允許這個主站嵌入，少了這兩個值時一律 `'none'`（簡報無法顯示）。

審查用整合檢查（獨立埠 8811、獨立資料目錄，只關閉自己啟動的程序）：`node scripts/review-check.mjs`。

## 本機測試 Google 登入

`npm run test-auth` 會在 `.dev.vars` 寫入「假 Google」測試公鑰（只在 `ENVIRONMENT=development` 生效）與管理者 `admin@example.test`，再用 `npm run smoke:auth` 跑登入檢查。要在本機用真正的 Google 帳號登入：把 `.dev.vars` 的 `GOOGLE_CLIENT_ID` 換成你自己的真實值、刪掉 `GOOGLE_JWKS`，並用 `http://localhost:8801/teacher.html` 開啟。

> **警告：`DEV_LOGIN` 與 `GOOGLE_JWKS` 只能用在本機開發。** `DEV_LOGIN` 會開啟免 Google 驗證的測試登入入口，`GOOGLE_JWKS` 會讓伺服器改信任測試公鑰。兩者都必須同時符合「`ENVIRONMENT=development`」與「請求網址的主機名正好是 `localhost`、`127.0.0.1` 或 `[::1]`」才會生效；其他情況（正式部署、區網 IP、自訂網域、通道轉址）一律關閉，`/api/dev/login` 回 404。主機名來自請求的 Host 標頭，不能當成身分驗證，所以**絕對不要**在正式部署的環境設定 `DEV_LOGIN`、`GOOGLE_JWKS` 或 `ENVIRONMENT=development`，也不要把開著這些設定的 `wrangler dev` 綁到 `127.0.0.1` 以外的位址。

## 部署（需另行決定）

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put CREATE_SECRET   # 選用
```

在 Cloudflare 後台 Workers & Pages → ptt-teach → Settings → Variables and Secrets 設定 `GOOGLE_CLIENT_ID`、`ADMIN_EMAILS`（因 `keep_vars = true`，之後部署不會被覆蓋）。部署前請確認 Cloudflare 免費方案目前的 Durable Objects 與 WebSocket 訊息額度，並用預期人數壓測。

## 已知限制

- 選擇內建範例時沒有簡報檔案可載入；要播放動畫或 HTML 簡報頁，請選擇管理者已上傳且狀態為 `ready` 的簡報。
- 加入碼沒有嘗試次數限制（6 碼、32 種字元；場次最多存在 7 天）。
- 筆跡只在抬筆後送出，書寫過程不即時顯示；沒有雷射筆。
- 沒有 QR 圖產生器；可用任何 QR 工具把加入連結轉成 QR。
