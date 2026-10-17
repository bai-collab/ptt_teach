// 簡報主機 Worker（S3d-B；S4-A 隔離標頭強化）：以獨立 origin 提供簡報庫中的簡報檔案，供主站 live 頁以 sandbox iframe 載入。
// 安全設計：
// - 只接受 GET、HEAD。
// - 網址固定為 /<uploadId>/<path>：uploadId 必須是 32 位小寫十六進位；path 套用與上傳清單相同的規則（ASCII 白名單、
//   不得含 . 或 .. 路徑段、長度與深度上限、副檔名白名單）。不做任何百分比解碼：含 % 的路徑直接 404。
// - R2 鍵只來自 Catalog.resolveAsset（只有 ready／disabled 且路徑在清單內才回鍵）；絕不以 pathname 拼出 R2 鍵。
// - 每個回應（含 404／405／503、HEAD）都帶完整 CSP（契約 §4）、Permissions-Policy、X-DNS-Prefetch-Control、nosniff、CORS *；
//   Content-Type 由副檔名決定，不採用儲存端或用戶端的值。
// - CSP 只有兩個變動部分：<D>＝由請求網址算出的簡報主機 origin；frame-ancestors＝MAIN_ORIGIN（不合格一律 'none'）。
//   沒有任何能停用或放寬 CSP 的環境變數或旗標；ENVIRONMENT 只影響「MAIN_ORIGIN 未設定時能否用本機預設值」。
// - 不設 cookie、不讀也不記錄 Cookie 標頭；不輸出任何請求內容到日誌。
// - 內建簡報（方案 B）：以清單登記的代號＋路徑從 ASSETS（builtin-decks/）讀取並比對雜湊；未綁定 R2（DECKS）時，非內建代號一律 404。
import { checkManifestPath, contentTypeFor, UPLOAD_ID_RE } from "../../src/deck-upload.js";
import { devOnlyAllowed } from "../../src/auth.js";
import { BUILTIN_BY_UPLOAD_ID } from "../../src/builtin-decks.generated.js";

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const ROUTE_RE = /^\/([^/]+)\/(.+)$/;

// 精確 origin 的字面格式：scheme://host[:port]，host 只允許小寫英數、. 與 -（排除 *、空白、逗號、分號等），
// 另允許 IPv6 迴環 [::1]。先用這個格式擋掉萬用字元與多個值，再用 URL 正規化確認沒有被改寫。
const ORIGIN_RE = /^https?:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[0-9]{1,5})?$/;

// 本機開發預設的主站 origin：只在 ENVIRONMENT=development 而且請求主機名是迴環位址時才採用（比照主站 devOnlyAllowed）
const DEV_MAIN_ORIGIN = "http://localhost:8801";

/**
 * frame-ancestors 的值：只接受單一個精確的主站 origin；其餘一律 fail closed 回 "'none'"。
 * - 正式環境只接受 https；development＋迴環主機名才接受 http。
 * - 不得與簡報主機同主機名（含與簡報主機自己的 origin 相同）。
 */
function frameAncestorsFor(env, url) {
  const dev = devOnlyAllowed(env, url.hostname);
  let raw = typeof env.MAIN_ORIGIN === "string" ? env.MAIN_ORIGIN.trim() : "";
  if (!raw && dev) raw = DEV_MAIN_ORIGIN;
  if (!raw || !ORIGIN_RE.test(raw)) return "'none'";
  let u;
  try { u = new URL(raw); } catch { return "'none'"; }
  if (u.origin !== raw || u.username || u.password) return "'none'";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && dev)) return "'none'";
  if (u.origin === url.origin || u.hostname === url.hostname) return "'none'";
  return u.origin;
}

/**
 * 簡報主機的 CSP（契約 §4）。d＝請求網址算出的簡報主機 origin；ancestors＝frameAncestorsFor() 的結果。
 * 本函式刻意不接收 env：除了 MAIN_ORIGIN 以外，CSP 不受任何設定影響。
 */
function deckHostCsp(d, ancestors) {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${d} 'unsafe-inline'`,
    `style-src ${d} 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src ${d} data: https://fonts.gstatic.com`,
    `img-src ${d} data: blob:`,
    `media-src ${d} blob:`,
    `connect-src ${d}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

// 請求網址算不出合格 origin（例如本機以怪異 Host 標頭連線）時使用的全鎖定 CSP：不提供任何內容
const LOCKED_CSP = "sandbox; default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const PERMISSIONS_POLICY = ["camera", "microphone", "geolocation", "display-capture", "usb", "hid", "serial", "midi",
  "payment", "fullscreen", "clipboard-read", "clipboard-write"].map((f) => `${f}=()`).join(", ");

const STATIC_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Access-Control-Allow-Origin": "*",
  // 簡報可被撤銷：不讓瀏覽器或中介快取在撤銷後繼續提供
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-DNS-Prefetch-Control": "off",
  "Permissions-Policy": PERMISSIONS_POLICY,
});

function respond(csp, status, body, contentType, extra = {}, isHead = false) {
  const headers = new Headers(STATIC_HEADERS);
  headers.set("Content-Security-Policy", csp);
  headers.set("Content-Type", contentType);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(isHead ? null : body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const isHead = method === "HEAD";
    if (!ORIGIN_RE.test(url.origin)) return respond(LOCKED_CSP, 400, "Bad request", "text/plain; charset=utf-8", {}, isHead);
    const csp = deckHostCsp(url.origin, frameAncestorsFor(env, url));
    const text = (status, msg, extra = {}) => respond(csp, status, msg, "text/plain; charset=utf-8", extra, isHead);
    if (method !== "GET" && !isHead) return text(405, "Method not allowed", { Allow: "GET, HEAD" });
    const m = url.pathname.match(ROUTE_RE);
    if (!m) return text(404, "Not found");
    const [, uploadId, path] = m;
    // 先驗格式再查目錄：格式不合就不碰 Catalog 與 R2
    if (!UPLOAD_ID_RE.test(uploadId) || checkManifestPath(path) !== null) return text(404, "Not found");
    const contentType = contentTypeFor(path);
    if (!contentType) return text(404, "Not found");

    // 內建簡報（方案 B）：代號與路徑都必須在 src/builtin-decks.generated.js 的清單內；靜態檔由 ASSETS 讀取（run_worker_first，
    // 不直接對外），內容雜湊必須與清單一致才送出，回應標頭與 R2 簡報完全相同。代號不在清單內才繼續走簡報庫（R2）。
    const builtin = BUILTIN_BY_UPLOAD_ID.get(uploadId);
    if (builtin) {
      const want = builtin.files.get(path);
      if (typeof want !== "string" || !env.ASSETS) return text(404, "Not found");
      let res;
      try { res = await env.ASSETS.fetch(new Request(`https://assets.invalid/${builtin.folder}/${path}`)); } catch { return text(503, "Service unavailable"); }
      if (!res.ok) return text(404, "Not found");
      const buf = await res.arrayBuffer();
      if (hex(await crypto.subtle.digest("SHA-256", buf)) !== want) return text(503, "Service unavailable");
      return respond(csp, 200, isHead ? null : buf, contentType, { "Content-Length": String(buf.byteLength) }, isHead);
    }
    let key = null;
    try {
      const catalog = env.CATALOG.get(env.CATALOG.idFromName("catalog"));
      key = await catalog.resolveAsset(uploadId, path);
    } catch {
      return text(503, "Service unavailable");
    }
    if (typeof key !== "string" || !key || !env.DECKS) return text(404, "Not found");

    const obj = isHead ? await env.DECKS.head(key) : await env.DECKS.get(key);
    if (!obj) return text(404, "Not found");
    const extra = { "Content-Length": String(obj.size) };
    if (obj.httpEtag) extra.ETag = obj.httpEtag;
    return respond(csp, 200, isHead ? null : obj.body, contentType, extra, isHead);
  },
};
