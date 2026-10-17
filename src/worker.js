// AI 時代教育動畫｜研習互動版 Worker
// 講師：Google 登入（名單制）→ 建場、我的場次、產生備援講師連結；管理者在網頁維護講師名單
// 研習者：輸入加入碼 → WebSocket 連進該場的 Room（Durable Object）
// 其餘路徑交給靜態資源（public/）。
import { DurableObject } from "cloudflare:workers";
import defaultDeckSource from "../examples/ai-era-education.deck.json";
import { validateDeck, deriveRules, isPageIndex, isDiscPage, discKind, discPages, voteOptionCount, isVoteOption, isMapNode, isMapTag, isColumn, normalizeSeek } from "./deck.js";
import { verifyGoogleIdToken, devOnlyAllowed, signSession, readSession, getCookie, sessionCookie, adminEmails, bytesToB64url, EMAIL_RE, SESSION_COOKIE, SESSION_HOURS } from "./auth.js";
import { UPLOAD_LIMITS, DECK_ID_RE, DECK_VERSION_RE, UPLOAD_ID_RE } from "./deck-upload.js";
import { parseAskBody, buildPrompt, callNmking, AskError, ASK_LIMITS, NMKING_DEFAULT_MODEL } from "./ask.js";
import { BUILTIN_DECKS, builtinDeckFor } from "./builtin-decks.generated.js";
export { Catalog } from "./catalog.js";

const APP = "ptt-teach";
const CODE_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 排除 I O 0 1，避免抄錯
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const RETENTION_MS = 7 * 24 * 3600 * 1000; // 建場後 7 天自動刪除

const LIMITS = {
  conns: 200,
  msgBytes: 16 * 1024,
  nameLen: 16,
  noteLen: 100,
  noteGapMs: 3000,
  notesPerPage: 400,
  strokesPerPage: 1500,
  strokePts: 400, // 每筆最多 400 個點（x,y 兩兩一組）
  strokeBurst: 20, // 每 10 秒最多 20 筆
  labelLen: 60, // 講師文字標註最多 60 字
  labelsPerPage: 200,
};

// 頁數、討論頁種類、選項／節點／標籤／欄數與 seek 上限一律由場次的 deck 快照推導（src/deck.js），
// 這裡不再寫死。預設 deck 打包進 Worker；建場時重新驗證，未通過就不建場（fail closed）。
// 驗證通過才回傳 { deck（只含契約欄位的乾淨物件）, rules（凍結的頁面規則）}；任何問題回 null。
function loadDeck(value) {
  const r = validateDeck(value);
  if (!r.ok) return null;
  try { return { deck: r.deck, rules: deriveRules(r.deck) }; } catch { return null; }
}
const COLORS = ["#efe9d8", "#f2c14e", "#e8875b", "#7fb6d9", "#8fd18a"];

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return [...r].map((b) => CODE_ALPHA[b % CODE_ALPHA.length]).join("");
}
function randomKey() {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(24)));
}
const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const authStub = (env) => env.AUTH.get(env.AUTH.idFromName("auth"));

// 登入狀態：讀 cookie → 驗簽 → 每次都重新確認仍在講師名單（移除後立即失效）
async function currentUser(request, env) {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const auth = authStub(env);
  const data = await readSession(raw, await auth.sessionKey());
  if (!data) return null;
  const isAdmin = adminEmails(env).includes(data.email);
  const isPresenter = isAdmin || (await auth.isPresenter(data.email));
  if (!isPresenter) return null;
  return { email: data.email, name: data.name, isAdmin };
}
// 簡易 CSRF 防護：瀏覽器跨站送出的 POST/DELETE 會帶不同 Origin（另有 SameSite=Lax cookie）
const sameOrigin = (request, url) => { const o = request.headers.get("Origin"); return !o || o === url.origin; };

// ===================== 簡報主機 origin（S3d-B）=====================
// 簡報檔案一律由獨立 origin 的簡報主機（deck-host/）提供。DECK_ORIGIN 必須是「精確的 origin」（沒有路徑、結尾斜線、帳密），
// 主機名不得與主站相同（cookie 依主機名而非連接埠區分，同主機名＝同站，會失去隔離）；正式環境只接受 https。
// 不合格或未設定 → 回 null（fail closed）：live 頁 frame-src 只剩 'self'，場次 API 不提供簡報網址。
// 本機開發（ENVIRONMENT=development＋迴環主機名）未設定時，預設 http://127.0.0.1:8802（主站請用 localhost 開）。
const DEV_DECK_ORIGIN = "http://127.0.0.1:8802";
function deckOrigin(env, url) {
  const dev = devOnlyAllowed(env, url.hostname);
  let raw = typeof env.DECK_ORIGIN === "string" ? env.DECK_ORIGIN.trim() : "";
  if (!raw && dev) raw = DEV_DECK_ORIGIN;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && dev)) return null;
  if (u.origin !== raw || u.username || u.password) return null;
  if (u.hostname === url.hostname) return null;
  return u.origin;
}

// live 頁的 CSP（S4-A）：以 public/_headers 的站台 CSP 為底，另外收緊兩項（都是精確值，不用萬用字元）：
// - connect-src：'self'＋這個主站的精確 ws:／wss: origin（live 頁不用 Google 登入，不放 accounts.google.com）
// - frame-src：只放精確的簡報主機 origin（不放 'self'）；DECK_ORIGIN 不合格或未設定時 'none'（fail closed）
// 精確 origin 的字面格式：host 只允許小寫英數、. 與 -（排除 *、空白、逗號、分號），另允許 [::1]
const EXACT_ORIGIN_RE = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[0-9]{1,5})?$/;
function liveCsp(deck, url) {
  const wsOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  const connect = EXACT_ORIGIN_RE.test(url.origin) ? `'self' ${wsOrigin}` : "'self'";
  const frame = typeof deck === "string" && EXACT_ORIGIN_RE.test(deck) ? deck : "'none'";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com",
    `connect-src ${connect}`,
    `frame-src ${frame}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
async function servePage(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", liveCsp(deckOrigin(env, url), url));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// selected：null＝內建範例（S3d-C 之前的預設）；否則 { deckJson, uploadId }（只取自 Catalog.getReadyDeck）
async function createRoom(env, owner, selected = null) {
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const key = randomKey();
    const res = await roomStub(env, code).init(await sha256(key), code, owner || "", selected?.deckJson ?? null, selected?.uploadId ?? null);
    if (res.deckInvalid) return { error: "deckInvalid" }; // deck 未通過驗證：換加入碼也沒用
    if (res.ok) {
      if (owner) await authStub(env).addRoom(code, owner, Date.now(), res.expiresAt);
      return { code, key, expiresAt: res.expiresAt };
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // live 頁經過 Worker（wrangler.toml 的 run_worker_first）以產生含精確 frame-src 的 CSP
    if (path === "/live" || path === "/live.html") return servePage(request, env, url);
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    const method = request.method;
    if (method !== "GET" && !sameOrigin(request, url)) return json({ error: "來源不符" }, 403);
    const readJson = async () => { try { return await request.json(); } catch { return null; } };

    if (path === "/api/health") return json({ ok: true, app: APP });

    // ---- 登入 ----
    // 本機測試登入：只在 ENVIRONMENT=development、DEV_LOGIN=1（.dev.vars），而且請求主機名是迴環位址
    // （localhost／127.0.0.1／[::1]）時開啟；正式部署或非迴環主機名一律關閉
    const devLogin = devOnlyAllowed(env, url.hostname) && env.DEV_LOGIN === "1";
    if (path === "/api/auth/config") {
      return json({ googleClientId: env.GOOGLE_CLIENT_ID || null, secretEnabled: !!env.CREATE_SECRET, devLogin });
    }
    if (path === "/api/dev/login" && method === "POST") {
      if (!devLogin) return json({ error: "找不到" }, 404);
      const body = await readJson();
      const email = String(body?.email || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ error: "信箱格式不正確" }, 400);
      const auth = authStub(env);
      const isAdmin = adminEmails(env).includes(email);
      if (!isAdmin && !(await auth.isPresenter(email))) return json({ error: `${email} 不在講師名單中` }, 403);
      const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
      const value = await signSession({ email, name: email.split("@")[0], exp }, await auth.sessionKey());
      return json({ email, isAdmin }, 200, { "set-cookie": sessionCookie(value, url.protocol === "https:", SESSION_HOURS * 3600) });
    }
    if (path === "/api/auth/google" && method === "POST") {
      const body = await readJson();
      let who;
      try { who = await verifyGoogleIdToken(body?.credential, env, url.hostname); } catch (e) { return json({ error: e.message }, 401); }
      const auth = authStub(env);
      const isAdmin = adminEmails(env).includes(who.email);
      if (!isAdmin && !(await auth.isPresenter(who.email))) {
        return json({ error: `${who.email} 不在講師名單中，請洽管理者加入` }, 403);
      }
      const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
      const value = await signSession({ email: who.email, name: who.name, exp }, await auth.sessionKey());
      return json({ email: who.email, name: who.name, isAdmin }, 200,
        { "set-cookie": sessionCookie(value, url.protocol === "https:", SESSION_HOURS * 3600) });
    }
    if (path === "/api/auth/logout" && method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", url.protocol === "https:", 0) });
    }
    if (path === "/api/me") {
      const me = await currentUser(request, env);
      return me ? json(me) : json({ error: "尚未登入" }, 401);
    }

    // ---- 管理者：講師名單 ----
    if (path === "/api/admin/presenters") {
      const me = await currentUser(request, env);
      if (!me?.isAdmin) return json({ error: "只有管理者可以管理講師名單" }, 403);
      const auth = authStub(env);
      if (method === "GET") return json({ admins: adminEmails(env), presenters: await auth.listPresenters() });
      if (method === "POST") {
        const email = String((await readJson())?.email || "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return json({ error: "信箱格式不正確" }, 400);
        await auth.addPresenter(email, me.email);
        return json({ ok: true, presenters: await auth.listPresenters() });
      }
      if (method === "DELETE") {
        const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
        await auth.removePresenter(email);
        return json({ ok: true, presenters: await auth.listPresenters() });
      }
    }

    // ---- 管理者：AI 問答設定（S8）----
    // 金鑰只寫入 Auth DO，任何回應都不回傳金鑰本身（只回是否已設定與末 4 碼）。寫入／清除必須帶主站 Origin。
    if (path === "/api/admin/ai") {
      const me = await currentUser(request, env);
      if (!me?.isAdmin) return json({ error: "只有管理者可以設定 AI 問答" }, 403);
      const auth = authStub(env);
      const status = async () => aiStatus(env, await auth.getAiConfig());
      if (method === "GET") return json(await status());
      if (!exactOrigin(request, url)) return json({ error: "來源不符" }, 403);
      if (method === "PUT") {
        const body = await readJson();
        const key = typeof body?.key === "string" ? body.key.trim() : "";
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        if (key && !AI_KEY_RE.test(key)) return json({ error: "金鑰格式不正確（8–300 個可見字元，不含空白）" }, 400);
        if (model && !AI_MODEL_RE.test(model)) return json({ error: "模型名稱格式不正確" }, 400);
        if (!key && !(await auth.getAiConfig()).key) return json({ error: "請輸入金鑰" }, 400);
        await auth.setAiConfig(key || null, model, me.email);
        return json({ ok: true, ...(await status()) });
      }
      if (method === "DELETE") {
        await auth.clearAiConfig();
        return json({ ok: true, ...(await status()) });
      }
      return json({ error: "找不到" }, 404);
    }

    // ---- 講師：我的場次 ----
    if (path === "/api/my/rooms" && method === "GET") {
      const me = await currentUser(request, env);
      if (!me) return json({ error: "請先登入" }, 401);
      const rows = await authStub(env).myRooms(me.email);
      const rooms = [];
      for (const r of rows) {
        const info = await roomStub(env, r.code).info();
        if (info.exists) rooms.push({ code: r.code, createdAt: r.created, expiresAt: info.expiresAt, count: info.count });
      }
      return json({ rooms });
    }

    // ---- 建場：登入講師，或（備援）建場密語 ----
    if (path === "/api/rooms" && method === "POST") {
      const me = await currentUser(request, env);
      let owner = me?.email || null;
      const body = await readJson();
      if (!me) {
        const given = typeof body?.secret === "string" ? body.secret : "";
        if (!env.CREATE_SECRET || !given) return json({ error: "請先用 Google 登入" }, 401);
        // 比對雜湊值，避免依字串長度提早結束的時間差
        if ((await sha256(given)) !== (await sha256(env.CREATE_SECRET))) return json({ error: "建場密語不正確" }, 403);
      }
      // 選簡報（S3d-B）：deckId＋version 必須同時提供；只能選目錄中 ready 的簡報，deck 快照與 upload_id 只取自 Catalog。
      // 都沒提供時使用內建範例（S3d-C 加上選單前，維持現有建場流程）。身分確認之後才查目錄。
      let selected = null;
      const hasDeckId = body !== null && typeof body === "object" && body.deckId !== undefined;
      const hasVersion = body !== null && typeof body === "object" && body.version !== undefined;
      if (hasDeckId || hasVersion) {
        if (typeof body.deckId !== "string" || typeof body.version !== "string" || !DECK_ID_RE.test(body.deckId) || !DECK_VERSION_RE.test(body.version)) {
          return json({ error: "簡報代號或版本格式不正確", code: "deck_format" }, 400);
        }
        // 先查簡報庫（有 R2 時上傳的同 id＋version 會覆蓋內建）；找不到再用內建簡報（方案 B，隨簡報主機部署）
        const r = await catalogStub(env).getReadyDeck(body.deckId, body.version);
        if (r && typeof r.deck_json === "string" && typeof r.upload_id === "string" && UPLOAD_ID_RE.test(r.upload_id)) {
          selected = { deckJson: r.deck_json, uploadId: r.upload_id };
        } else {
          const b = builtinDeckFor(body.deckId, body.version);
          if (!b) return json({ error: "找不到可用的簡報（不存在、尚未完成上傳或已停用）", code: "deck_unavailable" }, 404);
          selected = { deckJson: b.deckJson, uploadId: b.uploadId };
        }
      }
      const r = await createRoom(env, owner, selected);
      if (r?.error === "deckInvalid") return json({ error: "簡報資料未通過驗證，無法建場", code: "deck_invalid" }, selected ? 422 : 503);
      return r ? json(r) : json({ error: "暫時無法產生加入碼，請再試一次" }, 503);
    }

    const m = path.match(/^\/api\/rooms\/([^/]+)(\/ws|\/link|\/ask)?$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "加入碼格式不正確" }, 400);
      const stub = roomStub(env, code);
      if (m[2] === "/ws") {
        // 跨站 WebSocket 劫持防護（S3d-B）：Origin 必填且必須完全等於主站 origin；沒有 Origin、"null"（sandbox 簡報頁）
        // 或簡報主機 origin 一律拒絕，避免惡意簡報頁帶著講師的 cookie 冒用講師身分
        if (request.headers.get("Origin") !== url.origin) return json({ error: "來源不符" }, 403);
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "需要 WebSocket" }, 426);
        // 只信任 Worker 自己驗過的身分：先清掉用戶端可能偽造的標頭
        const headers = new Headers(request.headers);
        headers.delete("X-AEE-Email");
        const me = await currentUser(request, env);
        if (me) headers.set("X-AEE-Email", me.email);
        return stub.fetch(new Request(request, { headers }));
      }
      if (m[2] === "/ask") {
        // S8 單頁 AI 問答：Origin 必填且等於主站；頁面文字只取自場次 deck 快照；次數上限在 Room DO；log 不記提問與回答
        if (method !== "POST") return json({ error: "找不到" }, 404);
        if (request.headers.get("Origin") !== url.origin) return json({ error: "來源不符" }, 403);
        const declared = Number(request.headers.get("Content-Length") || 0);
        if (declared > 4096) return json({ error: "請求太大" }, 413);
        let q;
        try { q = parseAskBody(await readJson()); } catch (e) { return json({ error: e instanceof AskError ? e.message : "請求格式不正確" }, e instanceof AskError ? e.status : 400); }
        const who = q.pid || request.headers.get("CF-Connecting-IP") || "anon";
        const ai = await aiConfig(env);
        const r = await stub.askAcquire(q.page, who, !!ai.key);
        if (!r?.ok) return json({ error: r?.error || "無法提問" }, r?.status || 400);
        try {
          const answer = await callNmking({ NMKING_API_KEY: ai.key, NMKING_MODEL: ai.model, NMKING_ENDPOINT: env.NMKING_ENDPOINT, ENVIRONMENT: env.ENVIRONMENT }, url.hostname, buildPrompt(r.ctx, q.question));
          return json({ answer });
        } catch (e) {
          return json({ error: e instanceof AskError ? e.message : "AI 服務暫時無法使用" }, e instanceof AskError ? e.status : 502);
        }
      }
      if (m[2] === "/link" && method === "POST") {
        // 備援講師連結：只有該場擁有者或管理者能產生
        const me = await currentUser(request, env);
        if (!me) return json({ error: "請先登入" }, 401);
        const o = await stub.ownerInfo();
        if (!o.alive) return json({ error: "場次不存在或已結束" }, 404);
        if (o.owner !== me.email && !me.isAdmin) return json({ error: "只有建立這個場次的講師可以產生講師連結" }, 403);
        const key = randomKey();
        await stub.addKey(await sha256(key));
        return json({ code, key });
      }
      if (!m[2] && method === "GET") {
        // 公開（不需登入）：欄位白名單。deck 是建場時驗證過的契約欄位快照；簡報網址由伺服器以 upload_id 組成。
        // 不回傳擁有者、金鑰雜湊、上傳者或任何目錄內部欄位。
        const info = await stub.info();
        if (!info?.exists) return json({ exists: false });
        const origin = deckOrigin(env, url);
        const deck = info.deck && typeof info.deck === "object" ? info.deck : null;
        const uploadId = typeof info.uploadId === "string" && UPLOAD_ID_RE.test(info.uploadId) ? info.uploadId : null;
        const deckBase = origin && uploadId && deck ? `${origin}/${uploadId}/` : null;
        return json({
          exists: true,
          expiresAt: info.expiresAt,
          count: info.count,
          deck,
          deckBase,
          deckUrl: deckBase && typeof deck.entry === "string" ? deckBase + deck.entry : null,
        });
      }
    }

    // ---- 簡報庫（S3c-1）----
    const deckRes = await handleDeckLibrary(request, env, url, path, method);
    if (deckRes) return deckRes;
    return json({ error: "找不到" }, 404);
  },
};

// ===================== 簡報庫（S3c-1）=====================
// 三步上傳：[1] POST /api/admin/deck-uploads → [2] PUT …/:uploadId/files/:index（每個請求只寫 1 個 R2 物件）→ [3] POST …/:uploadId/commit
// 狀態機與配額都在 Catalog DO（src/catalog.js）；這裡只做身分、Origin、HTTP 標頭與 R2 串流寫入。
const catalogStub = (env) => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const UPLOAD_BASE_RE = /^\/api\/admin\/deck-uploads\/([0-9a-f]{32})\/(commit|abort|files\/([^/]+))$/;
const DECK_ADMIN_RE = /^\/api\/admin\/decks\/([^/]+)\/([^/]+)\/(disable|revoke)$/;
const INDEX_RE = /^(0|[1-9][0-9]{0,3})$/;
// 所有會改變簡報庫的管理端點：Origin 必填且必須完全等於主站（全域檢查允許沒有 Origin，這裡更嚴格）
const exactOrigin = (request, url) => request.headers.get("Origin") === url.origin;

// ===================== AI 問答設定（S8）=====================
// 優先順序：管理者在網頁設定的金鑰／模型（Auth DO）→ 環境變數 NMKING_API_KEY／NMKING_MODEL → 預設模型。
const AI_KEY_RE = /^[\x21-\x7e]{8,300}$/;
const AI_MODEL_RE = /^[A-Za-z0-9._\/:-]{1,80}$/;
async function aiConfig(env) {
  const c = await authStub(env).getAiConfig();
  return { key: c.key || env.NMKING_API_KEY || "", model: c.model || env.NMKING_MODEL || "" };
}
function aiStatus(env, c) {
  const source = c.key ? "admin" : env.NMKING_API_KEY ? "env" : null;
  const key = c.key || env.NMKING_API_KEY || "";
  return {
    configured: !!key,
    source,
    last4: key && key.length >= 12 ? key.slice(-4) : null,
    model: c.model || env.NMKING_MODEL || NMKING_DEFAULT_MODEL,
    modelSource: c.model ? "admin" : env.NMKING_MODEL ? "env" : "default",
    updatedBy: c.key || c.model ? c.updatedBy : null,
    updatedAt: c.key || c.model ? c.updatedAt : null,
  };
}
const deckErr = (r) => json({ error: r.error, code: r.code, ...(r.path ? { path: r.path } : {}), ...(r.missing ? { missing: r.missing } : {}), ...(r.errors ? { errors: r.errors } : {}), ...(r.state ? { state: r.state } : {}) }, r.status);

// Content-Length 必填、為十進位整數；回傳數字，或錯誤回應
function contentLength(request) {
  const cl = request.headers.get("Content-Length");
  if (cl === null) return json({ error: "必須提供 Content-Length（不接受分塊傳輸）", code: "length_required" }, 411);
  if (!/^[0-9]{1,12}$/.test(cl)) return json({ error: "Content-Length 格式不正確", code: "bad_length" }, 400);
  return Number(cl);
}
// 以計數方式讀取本體：超過宣告長度或上限就停止；讀完的長度必須等於宣告長度
async function readBodyCounted(request, declared, max) {
  if (!request.body) return declared === 0 ? new Uint8Array(0) : null;
  const reader = request.body.getReader();
  const buf = new Uint8Array(declared);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > declared || n + value.byteLength > max) { try { await reader.cancel(); } catch { /* 略過 */ } return null; }
      buf.set(value, n);
      n += value.byteLength;
    }
  } catch { return null; } // 連線中斷、本體不完整
  return n === declared ? buf : null;
}

async function handleDeckLibrary(request, env, url, path, method) {
  // ---- 未綁定 R2（方案 B 正式部署）：上傳、撤銷與 R2 相關端點一律停用 ----
  if (!env.DECKS && (path.startsWith("/api/admin/deck-uploads") || path.startsWith("/api/admin/decks/") ||
      (devOnlyAllowed(env, url.hostname) && (path === "/api/dev/r2" || path === "/api/dev/catalog/cleanup")))) {
    return json({ error: "此部署未啟用簡報上傳（簡報以內建方式隨部署提供）", code: "uploads_disabled" }, 503);
  }
  // ---- 開發用：時鐘接縫、R2 檢視、目錄查詢（devOnlyAllowed＋對應旗標＋管理者，否則一律 404）----
  if (path === "/api/dev/clock" || path === "/api/dev/r2" || path === "/api/dev/catalog/ready-deck" || path === "/api/dev/catalog/cleanup") {
    const flag = path === "/api/dev/clock" ? env.DEV_CLOCK : env.DEV_INSPECT;
    if (!devOnlyAllowed(env, url.hostname) || flag !== "1") return json({ error: "找不到" }, 404);
    const me = await currentUser(request, env);
    if (!me?.isAdmin) return json({ error: "找不到" }, 404);
    const cat = catalogStub(env);
    if (path === "/api/dev/clock") {
      if (method === "GET") return json({ now: await cat.devNow() });
      if (method !== "POST") return json({ error: "找不到" }, 404);
      if (!exactOrigin(request, url)) return json({ error: "來源不符" }, 403);
      let body = null;
      try { body = await request.json(); } catch { /* 下面回 400 */ }
      const offsetMs = body?.offsetMs ?? 0;
      const quotaBytes = body?.quotaBytes ?? null;
      const r = await cat.devSetClock(offsetMs, quotaBytes);
      return r.ok ? json(r) : json({ error: "參數不正確" }, 400);
    }
    if (method !== "GET") return json({ error: "找不到" }, 404);
    if (path === "/api/dev/r2") {
      const prefix = url.searchParams.get("prefix") || "";
      if (!prefix.startsWith("decks/")) return json({ error: "prefix 必須以 decks/ 開頭" }, 400);
      const objects = [];
      let cursor;
      for (let i = 0; i < 10; i++) {
        const page = await env.DECKS.list({ prefix, cursor, limit: 1000, include: ["httpMetadata"] });
        // 只回傳中繼資料（鍵、大小、etag、上傳時間、伺服器設定的 Content-Type），不回傳內容
        for (const o of page.objects) objects.push({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded.toISOString(), contentType: o.httpMetadata?.contentType ?? null });
        if (!page.truncated) break;
        cursor = page.cursor;
      }
      return json({ objects });
    }
    if (path === "/api/dev/catalog/cleanup") {
      return json({ queue: (await cat.devCleanupQueue(url.searchParams.get("prefix") || "")) || [] });
    }
    const r = await cat.getReadyDeck(url.searchParams.get("id") || "", url.searchParams.get("version") || "");
    if (!r) return json({ deck: null });
    let title = null;
    try { title = JSON.parse(r.deck_json).title; } catch { /* 略過 */ }
    return json({ deck: { upload_id: r.upload_id, title } });
  }

  // ---- 列表：講師與管理者；未登入 401 ----
  if (path === "/api/decks") {
    if (method !== "GET") return json({ error: "找不到" }, 404);
    const me = await currentUser(request, env);
    if (!me) return json({ error: "請先登入" }, 401);
    // ?include=builtin（講師頁建場選單）才附上內建簡報，排在前面；與簡報庫 ready 項目 id＋version 相同者不列出（建場時簡報庫優先）。
    // 預設只回簡報庫（管理者的簡報庫表格使用；內建簡報不能停用或撤銷，不出現在那裡）。
    const library = await catalogStub(env).list(!!me.isAdmin);
    if (url.searchParams.get("include") !== "builtin") return json({ decks: library });
    const keys = new Set(library.filter((d) => d.state === "ready").map((d) => `${d.id}@${d.version}`));
    const builtin = BUILTIN_DECKS.filter((d) => !keys.has(`${d.id}@${d.version}`))
      .map((d) => ({ id: d.id, version: d.version, title: d.title, state: "ready", created_at: 0, builtin: true }));
    return json({ decks: [...builtin, ...library] });
  }

  // ---- [1] 開始上傳 ----
  if (path === "/api/admin/deck-uploads") {
    if (method !== "POST") return json({ error: "找不到" }, 404);
    if (!exactOrigin(request, url)) return json({ error: "來源不符" }, 403);
    const me = await currentUser(request, env);
    if (!me?.isAdmin) return json({ error: "只有管理者可以上傳簡報" }, 403);
    const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (ct !== "application/json") return json({ error: "Content-Type 必須是 application/json", code: "content_type" }, 415);
    const n = contentLength(request);
    if (n instanceof Response) return n;
    if (n > UPLOAD_LIMITS.bodyBytes) return json({ error: "本體超過 512 KiB", code: "body_too_large" }, 413);
    const bytes = await readBodyCounted(request, n, UPLOAD_LIMITS.bodyBytes);
    if (!bytes) return json({ error: "本體長度與 Content-Length 不符", code: "bad_length" }, 400);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return json({ error: "本體不是合法 UTF-8", code: "body_utf8" }, 400); }
    const r = await catalogStub(env).begin(text, me.email);
    return r.ok ? json({ uploadId: r.uploadId, id: r.id, version: r.version, expiresAt: r.expiresAt, files: r.files }) : deckErr(r);
  }

  // ---- [2] 上傳單檔、[3] 確認、中止 ----
  const um = path.match(UPLOAD_BASE_RE);
  if (um) {
    const [, uploadId, action, rawIndex] = um;
    const isPut = action.startsWith("files/");
    if ((isPut && method !== "PUT") || (!isPut && method !== "POST")) return json({ error: "找不到" }, 404);
    if (!exactOrigin(request, url)) return json({ error: "來源不符" }, 403);
    const me = await currentUser(request, env);
    if (!me?.isAdmin) return json({ error: "只有管理者可以上傳簡報" }, 403);
    const cat = catalogStub(env);
    if (action === "commit") { const r = await cat.commit(uploadId, me.email); return r.ok ? json({ ok: true, state: r.state, id: r.id, version: r.version }) : deckErr(r); }
    if (action === "abort") { const r = await cat.abort(uploadId, me.email); return r.ok ? json({ ok: true, state: r.state }) : deckErr(r); }

    if (!INDEX_RE.test(rawIndex)) return json({ error: "檔案序號必須是非負整數", code: "index_format" }, 400);
    const index = Number(rawIndex);
    const n = contentLength(request);
    if (n instanceof Response) return n;
    const prep = await cat.preparePut(uploadId, index, me.email);
    if (!prep.ok) return deckErr(prep);
    if (prep.already) return json({ ok: true, already: true }); // 已收到：不再寫 R2
    if (n !== prep.size) return json({ error: "Content-Length 與清單宣告的大小不符", code: "size_mismatch", path: prep.path }, 400);
    // 1. request.body 直接串流給 R2（不讀進記憶體），附 sha256；Content-Type 由伺服器依副檔名決定
    let put;
    try {
      put = await env.DECKS.put(prep.key, request.body, { sha256: prep.sha256, httpMetadata: { contentType: prep.contentType } });
    } catch {
      // 2. put 拋錯（含雜湊不符）：R2 不會留下這次的物件
      return json({ error: "檔案內容與清單的大小或 SHA-256 不符", code: "put_rejected", path: prep.path }, 400);
    }
    // 3. 比對回傳的 size 與（有提供時的）checksums.sha256；不符就刪除並回 400
    const got = put?.checksums?.sha256 ? [...new Uint8Array(put.checksums.sha256)].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
    if (!put || put.size !== prep.size || (got !== null && got !== prep.sha256)) {
      try { await env.DECKS.delete(prep.key); } catch { /* 交給清理 */ }
      return json({ error: "檔案內容與清單的大小或 SHA-256 不符", code: "size_mismatch", path: prep.path }, 400);
    }
    // 4. 回到 Catalog 記錄已收到前，再檢查一次狀態仍是 pending 且未逾期；否則刪除剛寫入的物件並回 409
    const mark = await cat.markReceived(uploadId, index, me.email);
    if (!mark.ok) {
      if (mark.deleteObject) { try { await env.DECKS.delete(prep.key); } catch { /* 交給第二次清理 */ } }
      return deckErr(mark);
    }
    return json({ ok: true, already: !!mark.already });
  }

  // ---- 停用、撤銷（任一位管理者）----
  const dm = path.match(DECK_ADMIN_RE);
  if (dm) {
    if (method !== "POST") return json({ error: "找不到" }, 404);
    if (!exactOrigin(request, url)) return json({ error: "來源不符" }, 403);
    const me = await currentUser(request, env);
    if (!me?.isAdmin) return json({ error: "只有管理者可以管理簡報庫" }, 403);
    const [, id, version, action] = dm;
    if (!DECK_ID_RE.test(id) || !DECK_VERSION_RE.test(version)) return json({ error: "找不到這份簡報", code: "deck_missing" }, 404);
    const cat = catalogStub(env);
    const r = action === "disable" ? await cat.disable(id, version) : await cat.revoke(id, version);
    return r.ok ? json({ ok: true, state: r.state }) : deckErr(r);
  }
  return null;
}

// 一場研習＝一個 Room。使用 WebSocket Hibernation：閒置時不佔用執行時間。
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensure();
  }

  // 建表（可重複呼叫）；endRoom 的 deleteAll 會連表一起清掉，所以每個入口都先確認
  ensure() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, page INTEGER, pid TEXT, name TEXT, text TEXT, tag INTEGER, tag2 INTEGER, pinned INTEGER DEFAULT 0, ts INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS votes (page INTEGER, pid TEXT, opt INTEGER, PRIMARY KEY (page, pid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS strokes (id TEXT PRIMARY KEY, page INTEGER, pid TEXT, color TEXT, w REAL, pts TEXT, ts INTEGER)`);
    // 講師文字標註（任何頁都可以放，所有人看得到）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, page INTEGER, x INTEGER, y INTEGER, text TEXT, color TEXT, ts INTEGER)`);
    // S8 單頁 AI 問答次數（只記誰、何時，不記提問內容）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS asks (who TEXT, ts INTEGER)`);
    // 投票與筆跡的作者暱稱：只送給講師（舊版資料表補欄位）
    for (const t of ["votes", "strokes"]) {
      const cols = this.sql.exec(`PRAGMA table_info(${t})`).toArray().map((c) => c.name);
      if (!cols.includes("name")) this.sql.exec(`ALTER TABLE ${t} ADD COLUMN name TEXT`);
    }
  }

  meta(k) {
    const row = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return row ? row.v : null;
  }
  setMeta(k, v) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }
  alive() {
    this.ensure();
    const exp = Number(this.meta("expiresAt") || 0);
    return exp > Date.now();
  }

  // 場次的 deck 快照與規則（記憶體快取；DO 重啟後從 SQLite 重新驗證、推導）。
  // 只在 alive() 為真之後呼叫。快照損壞時回 null：所有依 deck 判斷的訊息一律被拒（fail closed）。
  deckState() {
    if (this.deckCache !== undefined) return this.deckCache;
    const stored = this.meta("deck");
    let state = null;
    if (stored === null) {
      // 本版之前建立的場次沒有快照：退回預設 deck（與當時寫死的規則相同），並寫入固定下來
      state = loadDeck(defaultDeckSource);
      if (state) this.setMeta("deck", JSON.stringify(state.deck));
    } else {
      let parsed = null;
      try { parsed = JSON.parse(stored); } catch { /* 視為損壞 */ }
      state = loadDeck(parsed);
    }
    this.deckCache = state;
    return state;
  }
  rules() { return this.deckState()?.rules ?? null; }

  // ---- RPC（由 Worker 呼叫）----
  // deckJson／uploadId：由 Worker 從 Catalog.getReadyDeck 取得（S3d-B）；都為 null 時使用內建範例（沒有 upload_id）
  async init(keyHash, code, owner, deckJson = null, uploadId = null) {
    if (this.alive()) return { ok: false };
    // 先驗證 deck 再動任何資料；未通過就不建場（目錄裡的 deck 也重新驗證一次）
    let source = defaultDeckSource;
    if (deckJson !== null || uploadId !== null) {
      if (typeof deckJson !== "string" || typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId)) return { ok: false, deckInvalid: true };
      try { source = JSON.parse(deckJson); } catch { return { ok: false, deckInvalid: true }; }
    }
    const loaded = loadDeck(source);
    if (!loaded) return { ok: false, deckInvalid: true };
    // 過期但尚未清掉的舊資料：先清空再重建
    this.sql.exec(`DELETE FROM notes`); this.sql.exec(`DELETE FROM votes`); this.sql.exec(`DELETE FROM strokes`); this.sql.exec(`DELETE FROM labels`); this.sql.exec(`DELETE FROM asks`); this.sql.exec(`DELETE FROM meta`);
    const expiresAt = Date.now() + RETENTION_MS;
    this.setMeta("keyHashes", JSON.stringify([keyHash]));
    this.setMeta("code", String(code || ""));
    this.setMeta("owner", String(owner || ""));
    this.setMeta("expiresAt", String(expiresAt));
    this.setMeta("pres", JSON.stringify({ page: 0, t: 0, playing: false, at: Date.now() }));
    this.setMeta("deck", JSON.stringify(loaded.deck)); // 只存驗證後的契約欄位
    if (uploadId !== null) this.setMeta("upload_id", uploadId); // 簡報主機網址用；內建範例沒有
    this.deckCache = loaded;
    await this.ctx.storage.setAlarm(expiresAt);
    return { ok: true, expiresAt };
  }
  // S8：檢查頁面可否提問並扣一次額度。hasKey=false 時不扣額度，回 503。回傳 { ok, ctx } 或 { status, error }。
  async askAcquire(page, who, hasKey) {
    if (!this.alive()) return { status: 404, error: "場次不存在或已結束" };
    const d = this.deckState()?.deck;
    const pg = d && Array.isArray(d.pages) && Number.isInteger(page) ? d.pages[page] : undefined;
    if (!pg) return { status: 400, error: "頁碼不正確" };
    if (typeof pg.text !== "string" || !pg.text.trim()) return { status: 404, error: "這一頁不開放提問" };
    if (!hasKey) return { status: 503, error: "AI 問答未設定" };
    const now = Date.now();
    const w = String(who).slice(0, 64);
    const total = this.sql.exec(`SELECT COUNT(*) AS n FROM asks`).one().n;
    if (total >= ASK_LIMITS.perRoom) return { status: 429, error: "本場的 AI 問答次數已用完" };
    const recent = this.sql.exec(`SELECT COUNT(*) AS n FROM asks WHERE who = ? AND ts > ?`, w, now - 60000).one().n;
    if (recent >= ASK_LIMITS.perMinute) return { status: 429, error: "提問太頻繁，請一分鐘後再試" };
    this.sql.exec(`INSERT INTO asks (who, ts) VALUES (?, ?)`, w, now);
    let pageTitle = typeof pg.title === "string" ? pg.title : "";
    if (pg.type === "anim" && Array.isArray(d.segments) && d.segments[pg.seg]) {
      const sg = d.segments[pg.seg];
      pageTitle = [sg.group, sg.title].filter((x) => typeof x === "string" && x).join("・");
    }
    return { ok: true, ctx: { deckTitle: typeof d.title === "string" ? d.title : "", pageTitle, text: pg.text } };
  }
  async ownerInfo() {
    if (!this.alive()) return { alive: false };
    return { alive: true, owner: this.meta("owner") || null };
  }
  async addKey(keyHash) {
    if (!this.alive()) return { ok: false };
    const list = JSON.parse(this.meta("keyHashes") || "[]");
    list.push(keyHash);
    this.setMeta("keyHashes", JSON.stringify(list.slice(-10))); // 最多保留 10 把
    return { ok: true };
  }
  async info() {
    if (!this.alive()) return { exists: false };
    const uploadId = this.meta("upload_id");
    return {
      exists: true,
      expiresAt: Number(this.meta("expiresAt")),
      count: this.ctx.getWebSockets().length,
      deck: this.deckState()?.deck ?? null, // 驗證後的契約欄位；快照損壞時 null
      uploadId: uploadId && UPLOAD_ID_RE.test(uploadId) ? uploadId : null,
    };
  }

  // ---- WebSocket ----
  async fetch(request) {
    if (!this.alive()) return new Response("場次不存在或已結束", { status: 404 });
    if (this.ctx.getWebSockets().length >= LIMITS.conns) return new Response("本場人數已滿", { status: 503 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // X-AEE-Email 由 Worker 驗證登入後才設定（用戶端送來的同名標頭已被清掉）
    const authEmail = request.headers.get("X-AEE-Email") || null;
    pair[1].serializeAttachment({ pid: null, name: "", role: "guest", lastNote: 0, strokeTimes: [], authEmail });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch { /* 對方已斷線 */ } }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) { try { ws.send(s); } catch { /* 略過 */ } }
  }
  broadcastSplit(forPresenter, forOthers) {
    const a = JSON.stringify(forPresenter), b = JSON.stringify(forOthers);
    for (const ws of this.ctx.getWebSockets()) {
      const role = (ws.deserializeAttachment() || {}).role;
      try { ws.send(role === "presenter" ? a : b); } catch { /* 略過 */ }
    }
  }
  voters(page) {
    const list = Array.from({ length: voteOptionCount(this.rules(), page) }, () => []);
    for (const r of this.sql.exec(`SELECT opt, name FROM votes WHERE page = ? ORDER BY rowid`, page).toArray()) list[r.opt]?.push(r.name || "研習夥伴");
    return list;
  }
  sendVoters(page) {
    const s = JSON.stringify({ type: "voters", page, voters: this.voters(page) });
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() || {}).role === "presenter") { try { ws.send(s); } catch { /* 略過 */ } }
    }
  }
  presence(except) {
    const count = this.ctx.getWebSockets().filter((w) => w !== except).length;
    this.broadcast({ type: "presence", count }, except);
  }
  fail(ws, message) { this.send(ws, { type: "error", message }); }

  // 研習者狀態名單（跟隨／自由、所在頁）只送給講師
  roster(except) {
    const socks = this.ctx.getWebSockets().filter((w) => w !== except);
    const people = [];
    const presenters = [];
    for (const w of socks) {
      const a = w.deserializeAttachment() || {};
      if (!a.pid) continue;
      if (a.role === "presenter") presenters.push(w);
      else people.push({ pid: a.pid, name: a.name, mode: a.mode === "free" ? "free" : "follow", page: Number.isInteger(a.page) ? a.page : null });
    }
    if (!presenters.length) return;
    const s = JSON.stringify({ type: "roster", people });
    for (const w of presenters) { try { w.send(s); } catch { /* 略過 */ } }
  }

  snapshot(me) {
    const notes = this.sql.exec(`SELECT id, page, pid, name, text, tag, tag2, pinned, ts FROM notes ORDER BY ts`).toArray();
    const voteRows = this.sql.exec(`SELECT page, opt, COUNT(*) AS c FROM votes GROUP BY page, opt`).toArray();
    const state = this.deckState();
    const R = state?.rules ?? null;
    const votePages = discPages(R, "vote");
    const votes = {};
    for (const p of votePages) votes[p] = Array(voteOptionCount(R, p)).fill(0);
    for (const r of voteRows) if (isVoteOption(R, r.page, r.opt)) votes[r.page][r.opt] = r.c;
    const myVotes = {};
    for (const r of this.sql.exec(`SELECT page, opt FROM votes WHERE pid = ?`, me.pid).toArray()) myVotes[r.page] = r.opt;
    const isP = me.role === "presenter";
    const strokes = this.sql.exec(`SELECT id, page, pid, color, w, pts, name FROM strokes ORDER BY ts`).toArray()
      .map((s) => { const o = { ...s, pts: JSON.parse(s.pts) }; if (!isP) delete o.name; return o; });
    const voters = {};
    if (isP) for (const p of votePages) voters[p] = this.voters(p);
    return {
      type: "init",
      me,
      pres: JSON.parse(this.meta("pres")),
      now: Date.now(),
      expiresAt: Number(this.meta("expiresAt")),
      count: this.ctx.getWebSockets().length,
      notes, votes, myVotes, strokes, voters,
      labels: this.sql.exec(`SELECT id, page, x, y, text, color FROM labels ORDER BY ts`).toArray(),
      deck: state?.deck ?? null, // 驗證後的契約欄位（供前端渲染）
    };
  }

  voteCounts(page) {
    const R = this.rules();
    const counts = Array(voteOptionCount(R, page)).fill(0);
    for (const r of this.sql.exec(`SELECT opt, COUNT(*) AS c FROM votes WHERE page = ? GROUP BY opt`, page).toArray()) if (isVoteOption(R, page, r.opt)) counts[r.opt] = r.c;
    return counts;
  }

  async webSocketMessage(ws, raw) {
    if (!this.alive()) { this.send(ws, { type: "ended" }); ws.close(1000, "ended"); return; }
    if (typeof raw !== "string" || raw.length > LIMITS.msgBytes) return this.fail(ws, "訊息過大");
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.fail(ws, "格式錯誤"); }
    const at = ws.deserializeAttachment() || {};
    const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

    if (msg.type === "ping") return this.send(ws, { type: "pong" });

    if (msg.type === "hello") {
      const pid = typeof msg.pid === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(msg.pid) ? msg.pid : null;
      if (!pid) return this.fail(ws, "身分格式錯誤");
      let name = typeof msg.name === "string" ? msg.name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim() : "";
      name = [...name].slice(0, LIMITS.nameLen).join("") || "研習夥伴";
      let role = "participant";
      const owner = this.meta("owner");
      if (at.authEmail && owner && at.authEmail === owner) role = "presenter"; // 已登入的場次擁有者
      else if (typeof msg.key === "string" && msg.key) {
        const hashes = JSON.parse(this.meta("keyHashes") || "[]");
        if (hashes.includes(await sha256(msg.key))) role = "presenter";
        else this.fail(ws, "講師金鑰不正確，已用一般身分加入");
      }
      const next = { ...at, pid, name, role, mode: "follow", page: null };
      ws.serializeAttachment(next);
      this.send(ws, this.snapshot({ pid, name, role }));
      this.presence();
      this.roster();
      return;
    }
    if (!at.pid) return this.fail(ws, "請先完成加入");
    const presenter = at.role === "presenter";
    const R = this.rules(); // null（快照損壞）時下列 helper 一律回 false

    switch (msg.type) {
      case "state": {
        // 研習者回報自己是跟隨或自由觀看；自由時附上所在頁
        const mode = msg.mode === "free" ? "free" : "follow";
        const page = mode === "free" && isPageIndex(R, msg.page) ? msg.page : null;
        if (at.mode === mode && at.page === page) return;
        ws.serializeAttachment({ ...at, mode, page });
        this.roster();
        return;
      }
      case "pres": {
        if (!presenter) return this.fail(ws, "只有講師可以控制頁面");
        if (!isPageIndex(R, msg.page)) return;
        // seek 時間：數字且 0 ≤ t ≤ deck 總長，否則歸 0（字串不再轉型）
        const pres = { page: msg.page, t: normalizeSeek(R, msg.t), playing: !!msg.playing, at: Date.now() };
        this.setMeta("pres", JSON.stringify(pres));
        this.broadcast({ type: "pres", pres, now: Date.now() }, ws);
        return;
      }
      case "note.add": {
        const kind = discKind(R, msg.page);
        if (!kind) return this.fail(ws, "這一頁不能留言");
        let text = typeof msg.text === "string" ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";
        if (!text) return;
        if ([...text].length > LIMITS.noteLen) return this.fail(ws, `留言最多 ${LIMITS.noteLen} 字`);
        let tag = null, tag2 = null;
        if (kind === "map") {
          if (!isMapNode(R, msg.page, msg.tag) || !isMapTag(R, msg.page, msg.tag2)) return this.fail(ws, "請選擇節點與阻塞類型");
          tag = msg.tag; tag2 = msg.tag2;
        } else if (kind === "cols") {
          if (!isColumn(R, msg.page, msg.tag)) return this.fail(ws, "請選擇欄位");
          tag = msg.tag;
        }
        const now = Date.now();
        if (!presenter && now - (at.lastNote || 0) < LIMITS.noteGapMs) return this.fail(ws, "留言太快了，請稍等幾秒");
        const n = this.sql.exec(`SELECT COUNT(*) AS c FROM notes WHERE page = ?`, msg.page).one().c;
        if (n >= LIMITS.notesPerPage) return this.fail(ws, "這一頁的留言已達上限");
        const note = { id: crypto.randomUUID(), page: msg.page, pid: at.pid, name: at.name, text, tag, tag2, pinned: 0, ts: now };
        this.sql.exec(`INSERT INTO notes (id, page, pid, name, text, tag, tag2, pinned, ts) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          note.id, note.page, note.pid, note.name, note.text, note.tag, note.tag2, note.ts);
        ws.serializeAttachment({ ...at, lastNote: now });
        this.broadcast({ type: "note", note });
        return;
      }
      case "note.del": {
        const row = this.sql.exec(`SELECT pid FROM notes WHERE id = ?`, String(msg.id)).toArray()[0];
        if (!row) return;
        if (!presenter && row.pid !== at.pid) return this.fail(ws, "只能刪除自己的留言");
        this.sql.exec(`DELETE FROM notes WHERE id = ?`, String(msg.id));
        this.broadcast({ type: "note.del", id: String(msg.id) });
        return;
      }
      case "note.pin": {
        if (!presenter) return this.fail(ws, "只有講師可以置頂");
        const pinned = msg.pinned ? 1 : 0;
        this.sql.exec(`UPDATE notes SET pinned = ? WHERE id = ?`, pinned, String(msg.id));
        this.broadcast({ type: "note.pin", id: String(msg.id), pinned });
        return;
      }
      case "vote": {
        if (!isVoteOption(R, msg.page, msg.opt)) return;
        this.sql.exec(`INSERT INTO votes (page, pid, opt, name) VALUES (?, ?, ?, ?) ON CONFLICT(page, pid) DO UPDATE SET opt = excluded.opt, name = excluded.name`, msg.page, at.pid, msg.opt, at.name);
        this.send(ws, { type: "myvote", page: msg.page, opt: msg.opt });
        this.broadcast({ type: "votes", page: msg.page, counts: this.voteCounts(msg.page) });
        this.sendVoters(msg.page);
        return;
      }
      case "vote.reset": {
        if (!presenter || !isDiscPage(R, msg.page, "vote")) return;
        this.sql.exec(`DELETE FROM votes WHERE page = ?`, msg.page);
        this.broadcast({ type: "votes", page: msg.page, counts: this.voteCounts(msg.page), reset: true });
        this.sendVoters(msg.page);
        return;
      }
      case "stroke": {
        // 學員只能在討論頁畫；講師任何頁都能畫
        if (!isPageIndex(R, msg.page) || (!presenter && !isDiscPage(R, msg.page))) return this.fail(ws, "這一頁不能畫");
        const pts = msg.pts;
        if (!Array.isArray(pts) || pts.length < 4 || pts.length > LIMITS.strokePts * 2 || pts.length % 2) return;
        for (let i = 0; i < pts.length; i += 2) if (!isInt(pts[i], 0, 1600) || !isInt(pts[i + 1], 0, 900)) return;
        const color = COLORS.includes(msg.color) ? msg.color : COLORS[0];
        const w = Math.min(14, Math.max(2, Number(msg.w) || 4));
        const now = Date.now();
        const times = (at.strokeTimes || []).filter((x) => now - x < 10000);
        if (times.length >= LIMITS.strokeBurst) return this.fail(ws, "畫得太快了，請稍等");
        const n = this.sql.exec(`SELECT COUNT(*) AS c FROM strokes WHERE page = ?`, msg.page).one().c;
        if (n >= LIMITS.strokesPerPage) return this.fail(ws, "這一頁的筆跡已達上限");
        const stroke = { id: crypto.randomUUID(), page: msg.page, pid: at.pid, color, w, pts };
        this.sql.exec(`INSERT INTO strokes (id, page, pid, color, w, pts, ts, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          stroke.id, stroke.page, stroke.pid, color, w, JSON.stringify(pts), now, at.name);
        ws.serializeAttachment({ ...at, strokeTimes: [...times, now] });
        const cid = typeof msg.cid === "string" ? msg.cid.slice(0, 40) : null;
        this.broadcastSplit({ type: "stroke", stroke: { ...stroke, name: at.name }, cid }, { type: "stroke", stroke, cid });
        return;
      }
      case "stroke.del": {
        const row = this.sql.exec(`SELECT pid FROM strokes WHERE id = ?`, String(msg.id)).toArray()[0];
        if (!row) return;
        if (!presenter && row.pid !== at.pid) return;
        this.sql.exec(`DELETE FROM strokes WHERE id = ?`, String(msg.id));
        this.broadcast({ type: "stroke.del", id: String(msg.id) });
        return;
      }
      case "label.add": {
        if (!presenter) return this.fail(ws, "只有講師可以加文字標註");
        if (!isPageIndex(R, msg.page) || !isInt(msg.x, 0, 1600) || !isInt(msg.y, 0, 900)) return this.fail(ws, "標註位置不正確");
        const text = typeof msg.text === "string" ? msg.text.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
        if (!text) return;
        if ([...text].length > LIMITS.labelLen) return this.fail(ws, `文字標註最多 ${LIMITS.labelLen} 字`);
        const n = this.sql.exec(`SELECT COUNT(*) AS c FROM labels WHERE page = ?`, msg.page).one().c;
        if (n >= LIMITS.labelsPerPage) return this.fail(ws, "這一頁的文字標註已達上限");
        const label = { id: crypto.randomUUID(), page: msg.page, x: msg.x, y: msg.y, text, color: COLORS.includes(msg.color) ? msg.color : COLORS[1] };
        this.sql.exec(`INSERT INTO labels (id, page, x, y, text, color, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`, label.id, label.page, label.x, label.y, label.text, label.color, Date.now());
        this.broadcast({ type: "label", label });
        return;
      }
      case "label.del": {
        if (!presenter) return this.fail(ws, "只有講師可以刪除文字標註");
        this.sql.exec(`DELETE FROM labels WHERE id = ?`, String(msg.id));
        this.broadcast({ type: "label.del", id: String(msg.id) });
        return;
      }
      case "stroke.clear": {
        // 講師清除本頁標註：筆跡＋文字（任何頁）
        if (!presenter || !isPageIndex(R, msg.page)) return;
        this.sql.exec(`DELETE FROM strokes WHERE page = ?`, msg.page);
        this.sql.exec(`DELETE FROM labels WHERE page = ?`, msg.page);
        this.broadcast({ type: "stroke.clear", page: msg.page });
        return;
      }
      case "room.end": {
        if (!presenter) return this.fail(ws, "只有講師可以結束場次");
        await this.endRoom();
        return;
      }
    }
  }

  async endRoom() {
    const code = this.meta("code");
    if (code) { try { await this.env.AUTH.get(this.env.AUTH.idFromName("auth")).removeRoom(code); } catch { /* 略過 */ } }
    this.broadcast({ type: "ended" });
    for (const w of this.ctx.getWebSockets()) { try { w.close(1000, "ended"); } catch { /* 略過 */ } }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.deckCache = undefined;
  }

  async webSocketClose(ws) { this.presence(ws); this.roster(ws); }
  async webSocketError(ws) { this.presence(ws); this.roster(ws); }
  async alarm() { await this.endRoom(); }
}

// 全站唯一的 Auth：講師名單、講師的場次索引、登入 cookie 的簽章金鑰（首次使用時自動產生）
export class Auth extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS presenters (email TEXT PRIMARY KEY, added_by TEXT, added_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, owner TEXT, created INTEGER, expires INTEGER)`);
  }
  async sessionKey() {
    const row = this.sql.exec(`SELECT v FROM kv WHERE k = 'hmac'`).toArray()[0];
    if (row) return row.v;
    const key = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec(`INSERT INTO kv (k, v) VALUES ('hmac', ?)`, key);
    return key;
  }
  async isPresenter(email) {
    return this.sql.exec(`SELECT 1 FROM presenters WHERE email = ?`, String(email)).toArray().length > 0;
  }
  async listPresenters() {
    return this.sql.exec(`SELECT email, added_by AS addedBy, added_at AS addedAt FROM presenters ORDER BY added_at`).toArray();
  }
  async addPresenter(email, by) {
    this.sql.exec(`INSERT INTO presenters (email, added_by, added_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`, email, by, Date.now());
  }
  async removePresenter(email) {
    this.sql.exec(`DELETE FROM presenters WHERE email = ?`, String(email));
  }
  async addRoom(code, owner, created, expires) {
    this.sql.exec(`INSERT INTO rooms (code, owner, created, expires) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET owner = excluded.owner, created = excluded.created, expires = excluded.expires`, code, owner, created, expires);
    this.sql.exec(`DELETE FROM rooms WHERE expires < ?`, Date.now());
  }
  async removeRoom(code) {
    this.sql.exec(`DELETE FROM rooms WHERE code = ?`, String(code));
  }
  // AI 問答設定（S8）：金鑰只在 Worker 內部使用，不經任何 API 回傳
  async getAiConfig() {
    const row = this.sql.exec(`SELECT v FROM kv WHERE k = 'ai'`).toArray()[0];
    let c = null; try { c = row ? JSON.parse(row.v) : null; } catch { c = null; }
    return { key: typeof c?.key === "string" ? c.key : "", model: typeof c?.model === "string" ? c.model : "", updatedBy: c?.updatedBy ?? null, updatedAt: c?.updatedAt ?? null };
  }
  // key 為 null 時保留原金鑰、只改模型
  async setAiConfig(key, model, by) {
    const cur = await this.getAiConfig();
    const v = JSON.stringify({ key: key ?? cur.key, model: String(model || ""), updatedBy: String(by || ""), updatedAt: Date.now() });
    this.sql.exec(`INSERT INTO kv (k, v) VALUES ('ai', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, v);
  }
  async clearAiConfig() {
    this.sql.exec(`DELETE FROM kv WHERE k = 'ai'`);
  }
  async myRooms(owner) {
    return this.sql.exec(`SELECT code, created, expires FROM rooms WHERE owner = ? AND expires > ? ORDER BY created DESC`, String(owner), Date.now()).toArray();
  }
}
