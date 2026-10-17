# 動畫簡報契約 v1（deck.json＋postMessage 協定）

- 狀態：草案（計畫 `planned/26-10-16-ptt-teach-split-plan.md` 節點 S2）；S3 實作、S4 隔離載入、S5 驗證器都以本文件為準。
- 檔案：Schema `schema/deck.schema.json`；範例 `examples/ai-era-education.deck.json`（由現行 `public/live.js` 與動畫 `SEGS` 轉出，22 頁、16 段，與 `src/worker.js` 的 `PAGE_COUNT`／`DISC` 一致）。

## 1. 簡報包（deck.zip）

```text
deck.zip
├─ deck.json        ← 本契約（必要）
├─ index.html       ← entry；runtime=timeline 時必須實作 §3 協定
├─ assets/…         ← 圖片、字型、腳本（相對路徑）
└─ slides/*.html    ← 選用：runtime=static 或 html 頁使用
```

- 簡報是**資料**：上傳到 R2 `decks/<id>/<version>/…`，不需要重新部署 Worker。
- 同一 `id` 的每個 `version` 不可變（immutable）；講師建場時鎖定 `id＋version`，之後更新簡報不影響進行中的場次。
- 所有路徑都是相對路徑：不得以 `/` 開頭、不得含 `..` 或 `//`，副檔名須為 `.html`（Schema `$defs.path`）。

## 2. deck.json

| 欄位 | 必要 | 說明 |
|---|---|---|
| `contract` | ✓ | 固定 `1` |
| `id` | ✓ | 小寫英數與 `-`，2–48 字 |
| `title` | ✓ | ≤80 字 |
| `version` | ✓ | 例：`2026-10-16` |
| `entry` | ✓ | 動畫主頁（例：`index.html`） |
| `runtime` | ✓ | `timeline`：支援 §3 時間同步；`static`：不同步時間，只同步頁碼 |
| `segments` | timeline 必要 | 動畫分段：`group`、`title`、`duration`（秒）；static 不得填 |
| `pages` | ✓ | 1–100 頁，依順序排列；種類見下表 |

**頁面種類**

| `type` | 用途 | 欄位 |
|---|---|---|
| `anim` | 動畫段（只用於 timeline） | `seg`（segments 索引） |
| `html` | 整頁顯示簡報包內某個 HTML，只同步頁碼 | `path`、`title` |
| `disc` | 討論頁，**由平台渲染**，不寫在動畫 HTML 裡 | `kind`、`kicker`、`title`、`prompt`，依 kind 另有欄位 |

**討論頁 kind**

| `kind` | 額外欄位 | 上限 |
|---|---|---|
| `vote` | `options` | 2–8 個，每個 ≤40 字 |
| `wall` | — | — |
| `map` | `nodes`、`tags`（`label`＋`color` `#RRGGBB`） | 節點 2–12、標籤 1–6 |
| `cols` | `columns` | 2–4 欄 |

- 每頁都可填 `text`（≤2000 字）：本頁重點文字，**S8 單頁問答的資料來源**；沒有 `text` 的頁面不開放提問。
- **Schema 管不到、須由驗證器（S5）另外檢查**：
  1. timeline：每個 `anim.seg` 都小於 `segments.length`；static：不得出現 `anim` 頁。
  2. `entry` 與每個 `html.path` 都真的存在於簡報包中。
  3. 每段 `duration` 總和 ≤ 2 小時。
- 平台端（Worker 與前端）一律把 deck.json 的字串當**純文字**（`textContent`），不解析 HTML。
- Worker 的頁面驗證改從 deck.json 推導：頁數＝`pages.length`；討論頁＝`type=disc` 的索引與 `kind`；投票選項數＝`options.length`；地圖節點／標籤數、欄數同理。不再寫死 `PAGE_COUNT`／`DISC`。

## 3. postMessage 協定（runtime=timeline）

```text
主站 live 頁（主站 origin）                     簡報 iframe（簡報專用 origin，sandbox="allow-scripts"）
   │                                                │
   │  ◀── {ptt:1, type:"ready", duration} ──────────│  載入完成（字型、圖片就緒）後送一次
   │                                                │
   │  ── {ptt:1, type:"seek", t} ─────────────────▶ │  依時間 t（秒，整份動畫的絕對時間）重畫
   │      （每個畫面影格，或暫停時每 0.4 秒一次）        │
   │                                                │
   │  ◀── {ptt:1, type:"error", code} ──────────────│  選用：無法顯示時回報（code 為英數短字串）
```

**訊息格式**（所有訊息都是純 JSON 物件，不得帶函式或 DOM 物件）

| 方向 | `type` | 欄位 | 規則 |
|---|---|---|---|
| 簡報→主站 | `ready` | `duration`（秒，數字） | 與 deck.json `segments` 的總長相差超過 0.5 秒時，主站以 deck.json 為準並在講師端顯示警告 |
| 主站→簡報 | `seek` | `t`（數字，0 ≤ t ≤ duration） | 簡報必須**冪等**：同一個 t 重複送來，畫面相同；畫面只由 t 決定 |
| 簡報→主站 | `error` | `code`（`^[a-z0-9_-]{1,32}$`） | 主站只記錄，不顯示原文 |

- 所有訊息都帶 `ptt: 1`（協定版本）；版本不符或欄位不合格一律丟棄。
- 動畫頁偵測 `?embed=1` 時，隱藏自己的播放器外殼（標題列、控制列、章節），只留舞台與字幕；播放由主站控制。

**主站端規則**

1. **只接受來自本 iframe 的訊息**：`event.source === iframe.contentWindow`，否則丟棄。因 iframe 沒有 `allow-same-origin`，其 origin 是不透明的 `"null"`，**不能用 `event.origin` 判斷**。
2. 主站→簡報的 `targetOrigin` 只能用 `"*"`（不透明 origin 無法指定），所以**主站送出的訊息只能含 `seek` 時間這類公開資料**，永遠不得帶登入資訊、場次代碼、使用者名稱或任何 token。
3. 每則收到的訊息先做 Schema 檢查（`ptt`、`type`、欄位型別與範圍），不合格丟棄；`ready` 每次 iframe 載入只接受第一則。
4. 簡報傳來的任何字串都不得進 `innerHTML`；主站顯示的頁名一律取自 deck.json。
5. 簡報 iframe 每次 `load` 都重設狀態（等待新的 `ready`）。

**簡報端規則**

1. 收到訊息先確認 `event.source === window.parent`，再檢查 `ptt`／`type`／`t`。
2. 只回應 §3 列出的訊息；不得呼叫 `window.parent` 的其他屬性（跨 origin 也做不到）。
3. 不得依賴 cookie、localStorage、對外連線（見 §4 的 CSP）。

**已移除的舊作法**：主站不再直接讀 `iframe.contentWindow.SEGS`、不再呼叫 `contentWindow.seek()`（跨 origin 後兩者都會失敗）；段落資料改由 deck.json 提供。

## 4. 隔離與標頭（S4-A 定稿：以下為實際生效的標頭）

| 項目 | 主站（live 頁） | 簡報主機（簡報專用 origin） |
|---|---|---|
| iframe 屬性 | `sandbox="allow-scripts"`（**不加** `allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-forms`）、`referrerpolicy="no-referrer"` | — |
| CSP | 由 Worker 的 `liveCsp()` 產生（見下） | 每個回應都送（含 404、405、503、HEAD），見下 |
| CORS | — | `Access-Control-Allow-Origin: *`（字型與 module script 在不透明 origin 下是 CORS 請求；簡報本身是公開資料） |
| 其他 | 主站 cookie 維持 `HttpOnly`；`Referrer-Policy: strict-origin-when-cross-origin` | 不設任何 cookie；`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-DNS-Prefetch-Control: off`、`Permissions-Policy`（見下） |

**簡報主機 CSP**（`deck-host/src/index.js`；`<D>`＝由請求網址算出的簡報主機 origin，`<M>`＝`MAIN_ORIGIN`）：

```text
sandbox allow-scripts; default-src 'none';
script-src <D> 'unsafe-inline';
style-src <D> 'unsafe-inline' https://fonts.googleapis.com;
font-src <D> data: https://fonts.gstatic.com;
img-src <D> data: blob:; media-src <D> blob:;
connect-src <D>; frame-src 'none'; worker-src 'none'; object-src 'none';
form-action 'none'; base-uri 'none'; frame-ancestors <M>
```

- 實際標頭是一行，指令之間以 `; ` 分隔；順序與上面相同。
- `connect-src <D>`：簡報可以 fetch 自己簡報包內的檔案（例如 `.json`）。簡報主機唯讀、內容公開，攻擊者讀不到存取紀錄。
- 不允許 `'unsafe-eval'`。外部白名單只有 Google Fonts 兩個網域；要增加，需要改本契約並經使用者同意。
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), hid=(), serial=(), midi=(), payment=(), fullscreen=(), clipboard-read=(), clipboard-write=()`。
- `webrtc 'block'`：**未加入**。S4-A 實測 Chrome 155.0.8059.79 回報「Unrecognized Content-Security-Policy directive 'webrtc'」，且 `new RTCPeerConnection()` 照常建立，因此不宣稱有效；WebRTC 類旁路由 S4-B 的 M14 量測，列為殘留風險。
- **`MAIN_ORIGIN` 判定**（比照主站 `devOnlyAllowed`）：
  - 只接受單一個精確 origin（`scheme://host[:port]`，host 只允許小寫英數、`.`、`-`，或 `[::1]`）；萬用字元、多個值、帶路徑或帳密、未正規化的值一律不合格。
  - 正式環境只接受 https；不得與簡報主機同主機名（含等於簡報主機自己的 origin）。
  - 只有 `ENVIRONMENT=development` 而且請求主機名是迴環位址（`localhost`／`127.0.0.1`／`[::1]`）時，未設定才使用預設值 `http://localhost:8801`。
  - 其餘情況（正式環境未設定、格式不合格）一律 fail closed：`frame-ancestors 'none'`。
  - **沒有任何能停用或放寬 CSP 的環境變數或旗標**；`ENVIRONMENT` 只影響上面的預設值。
  - 本機：`wrangler dev -c deck-host/wrangler.toml` 不讀專案根目錄的 `.dev.vars`，每個啟動簡報主機的地方（README、測試腳本）都明確傳 `--var ENVIRONMENT:development --var MAIN_ORIGIN:http://localhost:<主站埠>`。
- 請求網址算不出合格 origin（例如本機以怪異 Host 標頭連線）時回 400，CSP 為全鎖定的 `sandbox; default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`。

**主站 CSP**
- 站台 CSP（`public/_headers`）：`connect-src 'self' https://accounts.google.com/gsi/`（拿掉原本的 `ws:`／`wss:` 萬用字元）。
- live 頁（`src/worker.js` 的 `liveCsp()`，覆寫站台 CSP，只有一個 CSP 標頭）：
  - `connect-src 'self' <ws 或 wss>://<主站 host>`：精確的 WebSocket origin；live 頁不用 Google 登入，不放 `accounts.google.com`。
  - `frame-src <DECK_ORIGIN>`：只放精確的簡報主機 origin，不放 `'self'`；`DECK_ORIGIN` 未設定或不合格時 `frame-src 'none'`（fail closed）。

**量測結果（S4-A 開工第一步，2026-10-17）**：在 sandbox 的不透明 origin 下（`self.origin === "null"`），CSP 用 `'self'` 或用明確的簡報主機 origin，都能載入同一份簡報的相對路徑資源：module（三層 import）、CSS、字型、圖片、`fetch` 同 origin 的 JSON、mp3、mp4；頂層開啟與以 `sandbox="allow-scripts"` 的 iframe 嵌入兩種情況結果相同，沒有 CSP 違規。
- 瀏覽器：**Chrome 155.0.8059.79**（Windows，headless）。**Safari／iPad 與 Firefox 未驗證**（列入部署後檢查）。
- 正式設計一律用請求網址算出的**明確 origin**，不依賴各瀏覽器對不透明 origin 下 `'self'` 的解讀。
- 只有管理者能上傳簡報（W1 第 3 題未定前的預設）。

## 5. 不符合契約的網頁

| 情況 | 處理 |
|---|---|
| 任意單頁網頁 | 包成 `runtime: "static"`，每頁 `type: "html"`；只同步頁碼 |
| 想要時間同步 | 交給 AI 轉換 Skill（S5）補上 `?embed=1`、`ready`／`seek` 處理與 deck.json，人工確認後再匯入 |

**S4-A 補註（簡報主機 CSP 生效後）**：任意單頁網頁必須**自含資源**（所有 script、CSS、圖片、字型、媒體都放進簡報包，以相對路徑或 `data:` 引用）。下列作法在簡報主機上都會失效：
- 從 CDN 或其他網域載入 script、CSS、圖片、字型、媒體（唯一例外是 Google Fonts 的兩個網域）；
- 嵌入外部 iframe（`frame-src 'none'`）；
- `eval`、`new Function` 等需要 `'unsafe-eval'` 的程式；
- 對簡報主機以外的網址發出 fetch／XHR／WebSocket（`connect-src` 只有簡報主機自己）；
- Service Worker、Web Worker（`worker-src 'none'`）、表單送出（`form-action 'none'`）、`<base href>`（`base-uri 'none'`）。
可參考的合格樣本：`test/fixtures/legit-decks/full-features/`（mp3、mp4、fetch 自己的 JSON、`data:` 圖片與字型、兩層 module 鏈、html 頁、討論頁）。

## 6. 現有動畫的改動（S3／S4 落地時）

現行 `index.html` 已有 `window.SEGS`、`window.seek(t)`、`window.ready`、`?embed=1`。要符合本協定只需新增約 15 行：

```js
// 契約 v1：postMessage 介面（取代外層直接呼叫 window.seek）
addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.ptt !== 1 || m.type !== 'seek' || typeof m.t !== 'number' || !Number.isFinite(m.t)) return;
  window.seek(m.t);
});
window.ready.then(() => parent.postMessage({ ptt: 1, type: 'ready', duration: window.DURATION }, '*'));
```
