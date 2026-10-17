// deck.json 驗證模組（契約 v1，見 docs/deck-contract.md §2 與 schema/deck.schema.json）
// - 無任何 import：同時在 Cloudflare Workers 與 Node 22 執行。
// - validateDeck 永不丟例外；只輸出已知欄位組成的新物件（字串原樣保存，不解析 HTML）。
// - deriveRules 產生凍結的頁面規則，Worker 只透過下方 helper 判斷頁碼、討論頁與數值上下限。

export const DECK_CONTRACT = 1;
export const MAX_DECK_JSON_LENGTH = 256 * 1024; // JSON.stringify 結果的字元數上限（UTF-16 code units）
export const MAX_TOTAL_DURATION = 7200; // 秒（2 小時）
export const MAX_ERRORS = 100;

const LIMITS = Object.freeze({
  pagesMin: 1,
  pagesMax: 100,
  segmentsMin: 1,
  segmentsMax: 100,
  segDurationMax: 600,
  segIndexMax: 99,
  pageText: 2000,
  pathLen: 200,
  pathDepth: 8,
  vote: [2, 8],
  mapNodes: [2, 12],
  mapTags: [1, 6],
  cols: [2, 4],
});

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const TOP_KEYS = ["contract", "id", "title", "version", "entry", "runtime", "segments", "pages"];
const SEGMENT_KEYS = ["group", "title", "duration"];
const ANIM_KEYS = ["type", "seg", "text"];
const HTML_KEYS = ["type", "path", "title", "text"];
const DISC_BASE_KEYS = ["type", "kind", "kicker", "title", "prompt", "text"];
const DISC_KIND_KEYS = {
  vote: [...DISC_BASE_KEYS, "options"],
  wall: DISC_BASE_KEYS,
  map: [...DISC_BASE_KEYS, "nodes", "tags"],
  cols: [...DISC_BASE_KEYS, "columns"],
};
const DISC_KINDS = ["vote", "wall", "map", "cols"];
const TAG_KEYS = ["label", "color"];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function ptr(base, key) {
  let k = String(key);
  if (k.length > 64) k = k.slice(0, 64) + "…";
  return base + "/" + k.replace(/~/g, "~0").replace(/\//g, "~1");
}

class Errs {
  constructor() { this.list = []; this.overflow = false; }
  add(path, code, message) {
    if (this.list.length >= MAX_ERRORS) { this.overflow = true; return; }
    this.list.push({ path: path || "/", code, message });
  }
  get count() { return this.list.length; }
  result() {
    const out = this.list.slice();
    if (this.overflow) out.push({ path: "/", code: "too_many_errors", message: `錯誤超過 ${MAX_ERRORS} 筆，其餘省略` });
    return out;
  }
}

function checkKeys(obj, allowed, path, errs) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errs.add(ptr(path, k), "additional", "不允許的欄位");
  }
}

function checkRequired(obj, required, path, errs) {
  let ok = true;
  for (const k of required) {
    if (!hasOwn(obj, k)) { errs.add(ptr(path, k), "required", "缺少必要欄位"); ok = false; }
  }
  return ok;
}

// 文字欄位：型別、最小 1、最大 max（以 Unicode code point 計）；回傳原字串或 undefined
function text(v, path, errs, max, min = 1) {
  if (typeof v !== "string") { errs.add(path, "type", "必須是字串"); return undefined; }
  const n = codePointLength(v);
  if (n < min) { errs.add(path, "min_length", `至少 ${min} 字`); return undefined; }
  if (n > max) { errs.add(path, "max_length", `最多 ${max} 字`); return undefined; }
  return v;
}

function patterned(v, path, errs, re, maxLen) {
  if (typeof v !== "string") { errs.add(path, "type", "必須是字串"); return undefined; }
  if (v.length > maxLen || !re.test(v)) { errs.add(path, "pattern", "格式不符"); return undefined; }
  return v;
}

// 相對路徑：ASCII 白名單、.html 結尾、無 . / .. 片段、無 %、長度 ≤200、深度 ≤8
function relPath(v, path, errs) {
  if (typeof v !== "string") { errs.add(path, "type", "必須是字串"); return undefined; }
  if (v.length > LIMITS.pathLen) { errs.add(path, "path", `路徑最長 ${LIMITS.pathLen} 字元`); return undefined; }
  if (!PATH_RE.test(v)) { errs.add(path, "path", "路徑只能用 A-Z a-z 0-9 . _ - 與 /，且須為相對路徑"); return undefined; }
  const segs = v.split("/");
  if (segs.length > LIMITS.pathDepth) { errs.add(path, "path", `路徑最多 ${LIMITS.pathDepth} 層`); return undefined; }
  if (segs.some((s) => s === "." || s === "..") || v.includes("..")) { errs.add(path, "path", "路徑不得含 . 或 .. 片段"); return undefined; }
  if (!v.endsWith(".html")) { errs.add(path, "path", "副檔名須為 .html"); return undefined; }
  return v;
}

function textArray(v, path, errs, [min, max], itemMax) {
  if (!Array.isArray(v)) { errs.add(path, "type", "必須是陣列"); return undefined; }
  let bad = false;
  if (v.length < min) { errs.add(path, "min_items", `至少 ${min} 項`); bad = true; }
  if (v.length > max) { errs.add(path, "max_items", `最多 ${max} 項`); bad = true; }
  if (bad) return undefined;
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const s = text(v[i], ptr(path, i), errs, itemMax);
    if (s === undefined) bad = true; else out.push(s);
  }
  return bad ? undefined : out;
}

function validateSegments(v, errs) {
  const path = "/segments";
  if (!Array.isArray(v)) { errs.add(path, "type", "必須是陣列"); return undefined; }
  if (v.length < LIMITS.segmentsMin) { errs.add(path, "min_items", `至少 ${LIMITS.segmentsMin} 段`); return undefined; }
  if (v.length > LIMITS.segmentsMax) { errs.add(path, "max_items", `最多 ${LIMITS.segmentsMax} 段`); return undefined; }
  const out = [];
  let bad = false;
  for (let i = 0; i < v.length; i++) {
    const p = ptr(path, i);
    const s = v[i];
    if (!isPlainObj(s)) { errs.add(p, "type", "必須是物件"); bad = true; continue; }
    const before = errs.count;
    checkKeys(s, SEGMENT_KEYS, p, errs);
    checkRequired(s, ["title", "duration"], p, errs);
    const seg = {};
    if (hasOwn(s, "group")) seg.group = text(s.group, ptr(p, "group"), errs, 40);
    if (hasOwn(s, "title")) seg.title = text(s.title, ptr(p, "title"), errs, 40);
    if (hasOwn(s, "duration")) {
      const d = s.duration;
      const dp = ptr(p, "duration");
      if (typeof d !== "number" || !Number.isFinite(d)) errs.add(dp, "type", "必須是有限數字");
      else if (!(d > 0)) errs.add(dp, "minimum", "必須大於 0");
      else if (d > LIMITS.segDurationMax) errs.add(dp, "maximum", `最多 ${LIMITS.segDurationMax} 秒`);
      else seg.duration = d;
    }
    if (errs.count !== before || errs.overflow) { bad = true; continue; }
    const clean = {};
    if (seg.group !== undefined) clean.group = seg.group;
    clean.title = seg.title;
    clean.duration = seg.duration;
    out.push(clean);
  }
  return bad ? undefined : out;
}

function validatePage(pg, p, errs) {
  if (!isPlainObj(pg)) { errs.add(p, "type", "必須是物件"); return undefined; }
  if (!hasOwn(pg, "type")) { errs.add(ptr(p, "type"), "required", "缺少必要欄位"); return undefined; }
  const type = pg.type;
  const before = errs.count;
  const optText = (out) => {
    if (hasOwn(pg, "text")) {
      const t = text(pg.text, ptr(p, "text"), errs, LIMITS.pageText, 0);
      if (t !== undefined) out.text = t;
    }
  };
  if (type === "anim") {
    checkKeys(pg, ANIM_KEYS, p, errs);
    checkRequired(pg, ["seg"], p, errs);
    const out = { type: "anim" };
    if (hasOwn(pg, "seg")) {
      const sp = ptr(p, "seg");
      if (typeof pg.seg !== "number" || !Number.isInteger(pg.seg)) errs.add(sp, "integer", "必須是整數");
      else if (pg.seg < 0) errs.add(sp, "minimum", "不得小於 0");
      else if (pg.seg > LIMITS.segIndexMax) errs.add(sp, "maximum", `不得大於 ${LIMITS.segIndexMax}`);
      else out.seg = pg.seg;
    }
    optText(out);
    return errs.count === before && !errs.overflow ? out : undefined;
  }
  if (type === "html") {
    checkKeys(pg, HTML_KEYS, p, errs);
    checkRequired(pg, ["path"], p, errs);
    const out = { type: "html" };
    if (hasOwn(pg, "path")) out.path = relPath(pg.path, ptr(p, "path"), errs);
    if (hasOwn(pg, "title")) out.title = text(pg.title, ptr(p, "title"), errs, 40);
    optText(out);
    return errs.count === before && !errs.overflow ? out : undefined;
  }
  if (type === "disc") {
    if (!hasOwn(pg, "kind")) { errs.add(ptr(p, "kind"), "required", "缺少必要欄位"); return undefined; }
    const kind = pg.kind;
    if (typeof kind !== "string" || !DISC_KINDS.includes(kind)) {
      errs.add(ptr(p, "kind"), "enum", "kind 須為 vote、wall、map 或 cols");
      return undefined;
    }
    checkKeys(pg, DISC_KIND_KEYS[kind], p, errs);
    const req = ["title"];
    if (kind === "vote") req.push("options");
    if (kind === "map") req.push("nodes", "tags");
    if (kind === "cols") req.push("columns");
    checkRequired(pg, req, p, errs);
    const out = { type: "disc", kind };
    if (hasOwn(pg, "kicker")) out.kicker = text(pg.kicker, ptr(p, "kicker"), errs, 40);
    if (hasOwn(pg, "title")) out.title = text(pg.title, ptr(p, "title"), errs, 80);
    if (hasOwn(pg, "prompt")) out.prompt = text(pg.prompt, ptr(p, "prompt"), errs, 200);
    optText(out);
    if (kind === "vote" && hasOwn(pg, "options")) out.options = textArray(pg.options, ptr(p, "options"), errs, LIMITS.vote, 40);
    if (kind === "cols" && hasOwn(pg, "columns")) out.columns = textArray(pg.columns, ptr(p, "columns"), errs, LIMITS.cols, 40);
    if (kind === "map") {
      if (hasOwn(pg, "nodes")) out.nodes = textArray(pg.nodes, ptr(p, "nodes"), errs, LIMITS.mapNodes, 40);
      if (hasOwn(pg, "tags")) out.tags = validateTags(pg.tags, ptr(p, "tags"), errs);
    }
    return errs.count === before && !errs.overflow ? out : undefined;
  }
  errs.add(ptr(p, "type"), "enum", "type 須為 anim、html 或 disc");
  return undefined;
}

function validateTags(v, path, errs) {
  if (!Array.isArray(v)) { errs.add(path, "type", "必須是陣列"); return undefined; }
  const [min, max] = LIMITS.mapTags;
  if (v.length < min) { errs.add(path, "min_items", `至少 ${min} 項`); return undefined; }
  if (v.length > max) { errs.add(path, "max_items", `最多 ${max} 項`); return undefined; }
  const out = [];
  let bad = false;
  for (let i = 0; i < v.length; i++) {
    const p = ptr(path, i);
    const t = v[i];
    if (!isPlainObj(t)) { errs.add(p, "type", "必須是物件"); bad = true; continue; }
    const before = errs.count;
    checkKeys(t, TAG_KEYS, p, errs);
    checkRequired(t, TAG_KEYS, p, errs);
    const label = hasOwn(t, "label") ? text(t.label, ptr(p, "label"), errs, 40) : undefined;
    let color;
    if (hasOwn(t, "color")) {
      if (typeof t.color !== "string") errs.add(ptr(p, "color"), "type", "必須是字串");
      else if (!COLOR_RE.test(t.color)) errs.add(ptr(p, "color"), "pattern", "顏色須為 #RRGGBB");
      else color = t.color;
    }
    if (errs.count !== before) { bad = true; continue; }
    out.push({ label, color });
  }
  return bad ? undefined : out;
}

function validateClean(d, errs) {
  if (!isPlainObj(d)) { errs.add("/", "type", "deck 必須是 JSON 物件"); return undefined; }
  checkKeys(d, TOP_KEYS, "", errs);
  checkRequired(d, ["contract", "id", "title", "version", "entry", "runtime", "pages"], "", errs);
  const out = {};
  if (hasOwn(d, "contract")) {
    if (d.contract !== DECK_CONTRACT) errs.add("/contract", "const", `contract 必須是 ${DECK_CONTRACT}`);
    else out.contract = DECK_CONTRACT;
  }
  if (hasOwn(d, "id")) out.id = patterned(d.id, "/id", errs, ID_RE, 48);
  if (hasOwn(d, "title")) out.title = text(d.title, "/title", errs, 80);
  if (hasOwn(d, "version")) out.version = patterned(d.version, "/version", errs, VERSION_RE, 32);
  if (hasOwn(d, "entry")) out.entry = relPath(d.entry, "/entry", errs);
  let runtime;
  if (hasOwn(d, "runtime")) {
    if (d.runtime === "timeline" || d.runtime === "static") runtime = out.runtime = d.runtime;
    else errs.add("/runtime", "enum", "runtime 須為 timeline 或 static");
  }
  let segments;
  if (hasOwn(d, "segments")) {
    if (runtime === "static") errs.add("/segments", "segments_forbidden", "static 簡報不得有 segments");
    else segments = validateSegments(d.segments, errs);
  } else if (runtime === "timeline") {
    errs.add("/segments", "segments_required", "timeline 簡報必須有 segments");
  }
  if (segments) {
    let total = 0;
    for (const s of segments) total += s.duration;
    if (total > MAX_TOTAL_DURATION) errs.add("/segments", "total_duration", `所有段落總長不得超過 ${MAX_TOTAL_DURATION} 秒`);
    out.segments = segments;
  }
  if (hasOwn(d, "pages")) {
    const v = d.pages;
    if (!Array.isArray(v)) errs.add("/pages", "type", "必須是陣列");
    else if (v.length < LIMITS.pagesMin) errs.add("/pages", "min_items", `至少 ${LIMITS.pagesMin} 頁`);
    else if (v.length > LIMITS.pagesMax) errs.add("/pages", "max_items", `最多 ${LIMITS.pagesMax} 頁`);
    else {
      const pages = [];
      for (let i = 0; i < v.length; i++) {
        if (errs.overflow) break;
        const p = ptr("/pages", i);
        const pg = validatePage(v[i], p, errs);
        if (!pg) continue;
        if (pg.type === "anim") {
          if (runtime === "static") errs.add(p, "anim_forbidden", "static 簡報不得有 anim 頁");
          else if (segments && pg.seg >= segments.length) errs.add(ptr(p, "seg"), "seg_range", "seg 超出 segments 範圍");
        }
        pages.push(pg);
      }
      out.pages = pages;
    }
  }
  return out;
}

/**
 * 驗證 deck.json（已 JSON.parse 的值）。永不丟例外。
 * 先以 JSON 往返取得純資料快照（getter／toJSON 只觸發一次，之後只讀快照），再逐欄手寫檢查。
 * @param {unknown} input
 * @returns {{ok: true, deck: object} | {ok: false, errors: {path: string, code: string, message: string}[]}}
 */
export function validateDeck(input) {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, errors: [{ path: "/", code: "type", message: "deck 必須是 JSON 物件" }] };
    }
    let raw;
    try {
      raw = JSON.stringify(input);
    } catch {
      return { ok: false, errors: [{ path: "/", code: "not_serializable", message: "deck 無法序列化為 JSON" }] };
    }
    if (typeof raw !== "string") {
      return { ok: false, errors: [{ path: "/", code: "type", message: "deck 必須是 JSON 物件" }] };
    }
    if (raw.length > MAX_DECK_JSON_LENGTH) {
      return { ok: false, errors: [{ path: "/", code: "too_large", message: `deck.json 超過 ${MAX_DECK_JSON_LENGTH} 字元` }] };
    }
    const snapshot = JSON.parse(raw);
    const errs = new Errs();
    const deck = validateClean(snapshot, errs);
    if (errs.count > 0 || errs.overflow) return { ok: false, errors: errs.result() };
    return { ok: true, deck };
  } catch {
    return { ok: false, errors: [{ path: "/", code: "internal", message: "驗證時發生無法預期的錯誤" }] };
  }
}

/**
 * 解析並驗證 deck.json 原始文字（上傳用）。先檢查長度再 JSON.parse。永不丟例外。
 * @param {unknown} text
 */
export function parseDeckText(text) {
  if (typeof text !== "string") return { ok: false, errors: [{ path: "/", code: "type", message: "deck.json 必須是文字" }] };
  if (text.length > MAX_DECK_JSON_LENGTH) {
    return { ok: false, errors: [{ path: "/", code: "too_large", message: `deck.json 超過 ${MAX_DECK_JSON_LENGTH} 字元` }] };
  }
  let v;
  try { v = JSON.parse(text); } catch {
    return { ok: false, errors: [{ path: "/", code: "json", message: "deck.json 不是合法 JSON" }] };
  }
  return validateDeck(v);
}

function mustValidate(deck, fn) {
  const r = validateDeck(deck);
  if (!r.ok) {
    const e = new TypeError(`${fn}: deck 未通過驗證（${r.errors.map((x) => x.code).join(", ")}）`);
    e.errors = r.errors;
    throw e;
  }
  return r.deck;
}

/**
 * 由 deck 推導 Worker 需要的頁面規則（深度凍結的純物件）。
 * deck 會先重新驗證；不合格時丟 TypeError（呼叫端應在建場時處理）。
 * @param {object} deck
 * @returns {Readonly<{pageCount: number, maxSeekSeconds: number, pages: ReadonlyArray<Readonly<{type: string, kind?: string, optionCount?: number, nodeCount?: number, tagCount?: number, columnCount?: number, segStart?: number, segDuration?: number}>>}>}
 */
export function deriveRules(deck) {
  const d = mustValidate(deck, "deriveRules");
  const starts = [];
  let total = 0;
  if (d.runtime === "timeline") {
    for (const s of d.segments) { starts.push(total); total += s.duration; }
  }
  const pages = d.pages.map((pg) => {
    const r = { type: pg.type };
    if (pg.type === "anim") {
      r.segStart = starts[pg.seg];
      r.segDuration = d.segments[pg.seg].duration;
    } else if (pg.type === "disc") {
      r.kind = pg.kind;
      if (pg.kind === "vote") r.optionCount = pg.options.length;
      if (pg.kind === "map") { r.nodeCount = pg.nodes.length; r.tagCount = pg.tags.length; }
      if (pg.kind === "cols") r.columnCount = pg.columns.length;
    }
    return Object.freeze(r);
  });
  return Object.freeze({
    pageCount: pages.length,
    maxSeekSeconds: d.runtime === "timeline" ? total : 0,
    pages: Object.freeze(pages),
  });
}

/**
 * entry 與每個 html 頁的 path（去重、保持順序），供上傳時檢查檔案是否存在。
 * deck 會先重新驗證；不合格時丟 TypeError。
 * @param {object} deck
 * @returns {string[]}
 */
export function listReferencedPaths(deck) {
  const d = mustValidate(deck, "listReferencedPaths");
  const out = [d.entry];
  for (const pg of d.pages) if (pg.type === "html" && !out.includes(pg.path)) out.push(pg.path);
  return out;
}

// ---- Worker 用 helper：全部不丟例外；任何不合格輸入一律回 false／null ----

/** x 是整數且 min ≤ x ≤ max。 */
export function inRange(x, min, max) {
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
}

const rulesOk = (rules) => rules !== null && typeof rules === "object" && Array.isArray(rules.pages);

/** page 是此 deck 的合法頁碼（0 起算的整數）。 */
export function isPageIndex(rules, page) {
  return rulesOk(rules) && inRange(page, 0, rules.pages.length - 1);
}

/** 取得該頁規則；頁碼不合法回 null。 */
export function pageRule(rules, page) {
  return isPageIndex(rules, page) ? rules.pages[page] : null;
}

/** 該頁是討論頁；給 kind 時還須是該種類。 */
export function isDiscPage(rules, page, kind) {
  const r = pageRule(rules, page);
  if (!r || r.type !== "disc") return false;
  return kind === undefined || r.kind === kind;
}

/** 討論頁種類（vote／wall／map／cols）；非討論頁回 null。 */
export function discKind(rules, page) {
  const r = pageRule(rules, page);
  return r && r.type === "disc" ? r.kind : null;
}

/** 所有討論頁頁碼（可依 kind 篩選），遞增排序。 */
export function discPages(rules, kind) {
  if (!rulesOk(rules)) return [];
  const out = [];
  for (let i = 0; i < rules.pages.length; i++) if (isDiscPage(rules, i, kind)) out.push(i);
  return out;
}

/** 投票頁的選項數；非投票頁回 0。 */
export function voteOptionCount(rules, page) {
  return isDiscPage(rules, page, "vote") ? rules.pages[page].optionCount : 0;
}

/** opt 是該投票頁的合法選項索引。 */
export function isVoteOption(rules, page, opt) {
  return isDiscPage(rules, page, "vote") && inRange(opt, 0, rules.pages[page].optionCount - 1);
}

/** node 是該地圖頁的合法節點索引。 */
export function isMapNode(rules, page, node) {
  return isDiscPage(rules, page, "map") && inRange(node, 0, rules.pages[page].nodeCount - 1);
}

/** tag 是該地圖頁的合法標籤索引。 */
export function isMapTag(rules, page, tag) {
  return isDiscPage(rules, page, "map") && inRange(tag, 0, rules.pages[page].tagCount - 1);
}

/** col 是該分欄頁的合法欄索引。 */
export function isColumn(rules, page, col) {
  return isDiscPage(rules, page, "cols") && inRange(col, 0, rules.pages[page].columnCount - 1);
}

/** t 是合法的 seek 時間：有限數字且 0 ≤ t ≤ maxSeekSeconds（static 只接受 0）。 */
export function isSeekTime(rules, t) {
  return rulesOk(rules) && typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= rules.maxSeekSeconds;
}

/** 合法 seek 時間原樣回傳，否則回 0。 */
export function normalizeSeek(rules, t) {
  return isSeekTime(rules, t) ? t : 0;
}
