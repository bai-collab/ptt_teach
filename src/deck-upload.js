// 簡報上傳「開始」步驟的純驗證函式（S3c-1）
// - 不 import `cloudflare:workers`：同時供 src/catalog.js（Durable Object）與 Node 微基準（scripts/bench-begin.mjs）使用。
// - 全部同步、不丟例外；任何不合格輸入回 { ok: false, status, error, code, path }。
// - 以路徑為鍵的集合一律用 Map／Set，不用一般物件（避免 __proto__、constructor 之類的鍵污染原型）。
import { parseDeckText } from "./deck.js";

export const UPLOAD_LIMITS = Object.freeze({
  bodyBytes: 512 * 1024, // 開始上傳的 HTTP 本體（位元組）
  deckBytes: 128 * 1024, // deck.json 原文（UTF-8 位元組）
  filesMin: 1,
  filesMax: 300,
  fileBytesMin: 1,
  fileBytesMax: 10 * 1024 * 1024,
  totalBytesMax: 60 * 1024 * 1024,
  pathLen: 200,
  pathDepth: 8,
  pendingPerUploader: 2,
  pendingGlobal: 5,
  libraryBytesMax: 5 * 1024 * 1024 * 1024, // ready＋disabled＋pending 的總量上限
  decksMax: 200, // 不含墓碑（aborted／revoked）
  pendingTtlMs: 30 * 60 * 1000,
  secondCleanupMs: 10 * 60 * 1000,
});

// 與 src/deck.js 的相對路徑規則相同（白名單字元、不得含 ..、不得有 . 路徑段、長度 ≤200、深度 ≤8）
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const DOT_SEGMENT_RE = /(?:^|\/)\.(?:\/|$)/; // 「.」路徑段（「..」另由 includes("..") 擋下）
const SHA256_RE = /^[0-9a-f]{64}$/;
export const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;
// 與 src/deck.js 的 id／version 規則相同（供管理端點的網址參數檢查）
export const DECK_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const DECK_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;

// 副檔名白名單 → 伺服器決定的 Content-Type（用戶端送來的 Content-Type 一律不採用）
const CONTENT_TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["svg", "image/svg+xml"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
  ["txt", "text/plain; charset=utf-8"],
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (status, code, error, path = "/") => ({ ok: false, status, code, error, path });

/** 副檔名（小寫，不含點）；沒有副檔名回 ""。 */
function extOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

/** 依副檔名決定 Content-Type；不在白名單回 null。 */
export function contentTypeFor(path) {
  return CONTENT_TYPES.get(extOf(String(path))) ?? null;
}

const encoder = new TextEncoder();
/** 字串的 UTF-8 位元組數（原生 TextEncoder；落單的代理字元編成 U+FFFD，3 位元組）。 */
export function utf8ByteLength(s) {
  return encoder.encode(s).length;
}
/**
 * 字串的 UTF-8 位元組數是否超過 limit。每個 UTF-16 單元編成 1–3 位元組，先用長度做兩個免計算的捷徑；
 * 其餘以 encodeInto 寫進固定大小（limit＋4）的緩衝區：放不下（沒讀完整個字串）或寫入超過 limit 就是超過。
 */
let scratch = new Uint8Array(0);
export function utf8Exceeds(s, limit) {
  if (s.length > limit) return true;
  if (s.length * 3 <= limit) return false;
  if (scratch.length !== limit + 4) scratch = new Uint8Array(limit + 4);
  const { read, written } = encoder.encodeInto(s, scratch);
  return read < s.length || written > limit;
}

/** 清單中單一路徑的檢查（規則與 src/deck.js 的 relPath 相同，另加副檔名白名單）。回傳錯誤訊息或 null。 */
export function checkManifestPath(v) {
  if (typeof v !== "string") return "路徑必須是字串";
  if (v.length > UPLOAD_LIMITS.pathLen) return `路徑最長 ${UPLOAD_LIMITS.pathLen} 字元`;
  if (!PATH_RE.test(v)) return "路徑只能用 A-Z a-z 0-9 . _ - 與 /，且須為相對路徑";
  let depth = 1;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 0x2f) depth++;
  if (depth > UPLOAD_LIMITS.pathDepth) return `路徑最多 ${UPLOAD_LIMITS.pathDepth} 層`;
  if (v.includes("..") || DOT_SEGMENT_RE.test(v)) return "路徑不得含 . 或 .. 片段";
  if (v.length === 9 && v.toLowerCase() === "deck.json") return "檔案清單不得包含 deck.json";
  if (!CONTENT_TYPES.has(extOf(v))) return "不允許的副檔名";
  return null;
}

/**
 * 驗證檔案清單，並確認 deck 的 entry 與每個 html 頁都在清單中。
 * @returns {{ok: true, files: {path: string, size: number, sha256: string}[], totalBytes: number} | {ok: false, ...}}
 */
export function validateManifest(files, deck) {
  if (!Array.isArray(files)) return fail(400, "files_type", "files 必須是陣列", "/files");
  if (files.length < UPLOAD_LIMITS.filesMin || files.length > UPLOAD_LIMITS.filesMax) {
    return fail(400, "files_count", `檔案數必須是 ${UPLOAD_LIMITS.filesMin}–${UPLOAD_LIMITS.filesMax} 個`, "/files");
  }
  const seenLower = new Set();
  const exact = new Set();
  const out = [];
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const p = "/files/" + i;
    if (!isPlainObj(f)) return fail(400, "file_type", "清單項目必須是物件", p);
    for (const k of Object.keys(f)) if (k !== "path" && k !== "size" && k !== "sha256") return fail(400, "file_key", "清單項目有不允許的欄位", p);
    if (!hasOwn(f, "path") || !hasOwn(f, "size") || !hasOwn(f, "sha256")) return fail(400, "file_required", "清單項目缺少 path、size 或 sha256", p);
    const perr = checkManifestPath(f.path);
    if (perr) return fail(400, "file_path", perr, `${p}/path`);
    const lower = f.path.toLowerCase();
    if (seenLower.has(lower)) return fail(400, "file_duplicate", "檔案路徑重複（大小寫不分）", `${p}/path`);
    seenLower.add(lower);
    exact.add(f.path);
    const size = f.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < UPLOAD_LIMITS.fileBytesMin || size > UPLOAD_LIMITS.fileBytesMax) {
      return fail(400, "file_size", `單檔大小必須是 ${UPLOAD_LIMITS.fileBytesMin} 位元組到 10 MB 的整數`, `${p}/size`);
    }
    total += size;
    if (total > UPLOAD_LIMITS.totalBytesMax) return fail(400, "total_size", "檔案總和超過 60 MB", `${p}/size`);
    if (typeof f.sha256 !== "string" || !SHA256_RE.test(f.sha256)) return fail(400, "file_sha256", "sha256 必須是 64 位小寫十六進位", `${p}/sha256`);
    out.push({ path: f.path, size, sha256: f.sha256 });
  }
  if (!exact.has(deck.entry)) return fail(400, "entry_missing", "entry 不在檔案清單中", "/deck/entry");
  for (let i = 0; i < deck.pages.length; i++) {
    const pg = deck.pages[i];
    if (pg.type === "html" && !exact.has(pg.path)) return fail(400, "page_missing", "html 頁的檔案不在清單中", `/deck/pages/${i}/path`);
  }
  return { ok: true, files: out, totalBytes: total };
}

/**
 * 開始上傳的完整同步驗證：本體 JSON → deck.json 位元組上限 → parseDeckText（只呼叫一次）→ 清單。
 * @param {string} bodyText 已以計數方式讀取、確認 ≤ 512 KiB 的 HTTP 本體
 * @returns {{ok: true, deck: object, deckJson: string, files: object[], totalBytes: number} | {ok: false, status: number, code: string, error: string, path: string}}
 */
export function validateBeginBody(bodyText) {
  try {
    if (typeof bodyText !== "string") return fail(400, "body_type", "本體必須是文字");
    // Worker 已以計數方式確認本體 ≤ 512 KiB（位元組）；這裡只用字元數做便宜的防呆（字元數 ≤ 位元組數）
    if (bodyText.length > UPLOAD_LIMITS.bodyBytes) return fail(413, "body_too_large", "本體超過 512 KiB");
    let body;
    try { body = JSON.parse(bodyText); } catch { return fail(400, "body_json", "本體不是合法 JSON"); }
    if (!isPlainObj(body)) return fail(400, "body_type", "本體必須是 JSON 物件");
    for (const k of Object.keys(body)) if (k !== "deck" && k !== "files") return fail(400, "body_key", "本體有不允許的欄位", `/${k.slice(0, 40)}`);
    if (typeof body.deck !== "string") return fail(400, "deck_type", "deck 必須是 deck.json 的原文字串", "/deck");
    if (utf8Exceeds(body.deck, UPLOAD_LIMITS.deckBytes)) return fail(413, "deck_too_large", "deck.json 超過 128 KiB", "/deck");
    const parsed = parseDeckText(body.deck);
    if (!parsed.ok) {
      const e = parsed.errors[0] || { path: "/", message: "deck.json 未通過驗證" };
      return { ok: false, status: 400, code: "deck_invalid", error: "deck.json 未通過驗證", path: `/deck${e.path === "/" ? "" : e.path}`, errors: parsed.errors.slice(0, 20) };
    }
    const deck = parsed.deck;
    const m = validateManifest(body.files, deck);
    if (!m.ok) return m;
    return { ok: true, deck, deckJson: JSON.stringify(deck), files: m.files, totalBytes: m.totalBytes };
  } catch {
    return fail(400, "internal", "驗證時發生無法預期的錯誤");
  }
}

/**
 * 配額檢查（純函式）。usage 由 Catalog 以 SQL 算出：
 *   pendingByUploader：這位管理者目前的 pending 數；pendingGlobal：全站 pending 數；
 *   bytesInUse：ready＋disabled＋pending 的 bytes 總和；liveDecks：ready＋disabled＋pending 的筆數（不含墓碑）。
 */
export function checkQuota(usage, newBytes, limits = UPLOAD_LIMITS) {
  if (usage.pendingByUploader >= limits.pendingPerUploader) return fail(429, "quota_pending_user", `每位管理者同時最多 ${limits.pendingPerUploader} 個未完成的上傳`);
  if (usage.pendingGlobal >= limits.pendingGlobal) return fail(429, "quota_pending_global", `全站同時最多 ${limits.pendingGlobal} 個未完成的上傳`);
  if (usage.liveDecks >= limits.decksMax) return fail(409, "quota_decks", `簡報庫最多 ${limits.decksMax} 份簡報`);
  if (usage.bytesInUse + newBytes > limits.libraryBytesMax) return fail(413, "quota_bytes", "簡報庫總容量不足");
  return { ok: true };
}
