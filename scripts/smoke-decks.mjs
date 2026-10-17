// 簡報庫（S3c-1）冒煙測試：用 Node 模擬三步上傳（開始 → 逐檔 PUT → 確認），涵蓋權限、Origin、格式、清單路徑、
// 大小與數量、單檔上傳、確認、狀態機、並發、配額、清理、列表、開發用端點把關與 getReadyDeck。
// 自己啟動所需的 wrangler dev 實例（各自獨立的 --persist-to），記錄 PID，測完只關自己的程序樹（taskkill /T）：
//   - 開發實例      127.0.0.1:8821  ENVIRONMENT=development、DEV_CLOCK=1、DEV_INSPECT=1、三位管理者
//   - 正式模式實例  127.0.0.1:8822  ENVIRONMENT=production（同時打開兩個旗標，證明只靠 ENVIRONMENT 也會關閉）
//   - 未開旗標實例  127.0.0.1:8824  ENVIRONMENT=development、DEV_CLOCK=0、DEV_INSPECT=0
// 用法：node scripts/smoke-decks.mjs（不需要先啟動伺服器；不碰 8791／8801／8811／8812）
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const ADMINS = ["admin@example.test", "admin2@example.test", "admin3@example.test"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

let failed = 0, passed = 0;
const ok = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (c) passed++; else failed++; };

const INSTANCES = {
  dev: { port: 8821, persist: ".wrangler/smoke-decks-dev", vars: ["ENVIRONMENT:development", "DEV_LOGIN:1", "DEV_CLOCK:1", "DEV_INSPECT:1"] },
  prod: { port: 8822, persist: ".wrangler/smoke-decks-prod", vars: ["ENVIRONMENT:production", "DEV_CLOCK:1", "DEV_INSPECT:1"] },
  noflag: { port: 8824, persist: ".wrangler/smoke-decks-noflag", vars: ["ENVIRONMENT:development", "DEV_LOGIN:1", "DEV_CLOCK:0", "DEV_INSPECT:0"] },
};
const baseOf = (inst) => `http://127.0.0.1:${inst.port}`;

// ---- HTTP：node:http 才能控制 Host、Content-Length、分塊傳輸 ----
function req(inst, path, { method = "GET", headers = {}, body, cookie, origin = "same", host, chunked = false, noLength = false } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (origin === "same") h.origin = baseOf(inst);
  else if (origin) h.origin = origin;
  if (host) h.host = host;
  const buf = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  if (buf && !chunked && !noLength && h["content-length"] === undefined) h["content-length"] = buf.length;
  if (chunked) h["transfer-encoding"] = "chunked";
  return new Promise((resolve) => {
    const r = http.request({ hostname: "127.0.0.1", port: inst.port, path, method, headers: h, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = {}; try { data = JSON.parse(text); } catch {}
        const set = res.headers["set-cookie"];
        resolve({ status: res.statusCode, data, text, cookie: set ? String(set[0]).split(";")[0] : null });
      });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, data: { error: e.message }, text: "" }));
    if (buf) {
      if (chunked) { r.write(buf.subarray(0, Math.min(10, buf.length))); r.write(buf.subarray(Math.min(10, buf.length))); }
      else r.write(buf);
    }
    r.end();
  });
}
// 原始 TCP：送出與 Content-Length 不符的本體（node:http 會擋），halfClose 時送完就關閉寫入端
function rawTcp(inst, head, body, { halfClose = true, ms = 15000 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(inst.port, "127.0.0.1");
    const chunks = [];
    const done = () => { const t = Buffer.concat(chunks).toString("utf8"); const m = t.match(/^HTTP\/1\.[01] (\d{3})/); resolve({ status: m ? Number(m[1]) : 0, text: t }); };
    const timer = setTimeout(() => { s.destroy(); done(); }, ms);
    s.on("connect", () => { s.write(head); s.write(body); if (halfClose) s.end(); });
    s.on("data", (d) => chunks.push(d));
    s.on("end", () => { clearTimeout(timer); done(); });
    s.on("error", () => { clearTimeout(timer); done(); });
  });
}

// ---- 測試資料 ----
const example = JSON.parse(readFileSync(join(root, "examples", "ai-era-education.deck.json"), "utf8"));
const RUN = Date.now().toString(36);
let seq = 0;
const sha = (b) => createHash("sha256").update(b).digest("hex");
// 產生一份合法 deck 與檔案（entry=index.html，另含指定的檔案與 html 頁）
function makeDeck({ extra = [], htmlPages = [], id } = {}) {
  seq++;
  const deck = { ...example, id: id || `smk-${seq}`, version: `v${RUN}-${seq}`, title: `測試簡報 ${seq}` };
  if (htmlPages.length) deck.pages = [...example.pages, ...htmlPages.map((p) => ({ type: "html", path: p }))];
  const names = ["index.html", ...extra];
  const files = names.map((path, i) => { const content = Buffer.from(`<!-- ${path} ${RUN} ${seq} ${i} -->`); return { path, size: content.length, sha256: sha(content), content }; });
  return { deck, deckText: JSON.stringify(deck), files };
}
const manifest = (files) => files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
const beginBody = (d, files = manifest(d.files)) => JSON.stringify({ deck: d.deckText, files });

const D = INSTANCES.dev;
const begin = (cookie, body, opts = {}) => req(D, "/api/admin/deck-uploads", { method: "POST", cookie, body, headers: { "content-type": "application/json", ...(opts.headers || {}) }, ...opts });
const putFile = (cookie, uploadId, index, content, opts = {}) => req(D, `/api/admin/deck-uploads/${uploadId}/files/${index}`, { method: "PUT", cookie, body: content, ...opts });
const commit = (cookie, uploadId, opts = {}) => req(D, `/api/admin/deck-uploads/${uploadId}/commit`, { method: "POST", cookie, ...opts });
const abort = (cookie, uploadId, opts = {}) => req(D, `/api/admin/deck-uploads/${uploadId}/abort`, { method: "POST", cookie, ...opts });
const manage = (cookie, id, version, action, opts = {}) => req(D, `/api/admin/decks/${id}/${version}/${action}`, { method: "POST", cookie, ...opts });
const r2 = async (cookie, prefix) => (await req(D, `/api/dev/r2?prefix=${encodeURIComponent(prefix)}`, { cookie })).data.objects;
const readyDeck = async (cookie, id, version) => (await req(D, `/api/dev/catalog/ready-deck?id=${encodeURIComponent(id)}&version=${encodeURIComponent(version)}`, { cookie })).data;
const cleanupQueue = async (cookie, prefix) => (await req(D, `/api/dev/catalog/cleanup?prefix=${encodeURIComponent(prefix)}`, { cookie })).data.queue;
const setClock = (cookie, offsetMs, quotaBytes = null) => req(D, "/api/dev/clock", { method: "POST", cookie, body: { offsetMs, quotaBytes }, headers: { "content-type": "application/json" } });
const prefixOf = (d, uploadId) => `decks/${d.deck.id}/${d.deck.version}/${uploadId}/`;
async function waitFor(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; }
async function uploadAll(cookie, d) {
  const b = await begin(cookie, beginBody(d));
  if (b.status !== 200) return { b };
  for (let i = 0; i < d.files.length; i++) await putFile(cookie, b.data.uploadId, i, d.files[i].content);
  return { b, uploadId: b.data.uploadId };
}

// ---- 啟動伺服器 ----
const procs = [];
function startInstance(name, inst) {
  const persist = join(root, inst.persist);
  if (existsSync(persist)) rmSync(persist, { recursive: true, force: true }); // 只清自己的資料目錄
  const args = [wranglerJs, "dev", "--ip", "127.0.0.1", "--port", String(inst.port), "--persist-to", inst.persist, "--var", `ADMIN_EMAILS:${ADMINS.join(",")}`];
  for (const v of inst.vars) args.push("--var", v);
  const p = spawn(process.execPath, args, { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  inst.log = "";
  p.stdout.on("data", (d) => (inst.log += d)); p.stderr.on("data", (d) => (inst.log += d));
  procs.push(p);
  inst.pid = p.pid;
}
const stopAll = () => { for (const p of procs) if (p.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" }); };

try {
  for (const [name, inst] of Object.entries(INSTANCES)) {
    if ((await req(inst, "/api/health", { origin: null })).status !== 0) { ok(false, `${inst.port} 埠已被其他程序使用（不會關閉別人的程序）`); throw new Error("port busy"); }
  }
  for (const [name, inst] of Object.entries(INSTANCES)) startInstance(name, inst);
  for (const [name, inst] of Object.entries(INSTANCES)) {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); up = (await req(inst, "/api/health", { origin: null })).data.app === "ptt-teach"; }
    ok(up, `${name} 實例在 ${inst.port} 埠啟動（PID ${inst.pid}）`);
    if (!up) { console.log(inst.log.slice(-1500)); throw new Error("instance not up"); }
  }

  // ---- 登入（開發登入只限迴環主機）----
  const devLogin = async (inst, email) => (await req(inst, "/api/dev/login", { method: "POST", body: { email }, headers: { "content-type": "application/json" } })).cookie;
  const A = await devLogin(D, ADMINS[0]);
  const A2 = await devLogin(D, ADMINS[1]);
  const A3 = await devLogin(D, ADMINS[2]);
  await req(D, "/api/admin/presenters", { method: "POST", cookie: A, body: { email: "t1@example.test" }, headers: { "content-type": "application/json" } });
  const T = await devLogin(D, "t1@example.test");
  ok(!!(A && A2 && A3 && T), "取得三位管理者與一位講師的登入 cookie");

  // ================= 1. 權限 =================
  const d1 = makeDeck({ extra: ["a.png"] });
  const b1 = await begin(A, beginBody(d1));
  ok(b1.status === 200 && /^[0-9a-f]{32}$/.test(b1.data.uploadId), "對照：管理者可以開始上傳，取得 128 位元 uploadId");
  const U1 = b1.data.uploadId;
  ok((await begin(null, beginBody(makeDeck()))).status === 403, "未登入開始上傳 → 403");
  ok((await begin(T, beginBody(makeDeck()))).status === 403, "講師開始上傳 → 403");
  for (const [who, c] of [["未登入", null], ["講師", T], ["另一位管理者", A2]]) {
    ok((await putFile(c, U1, 0, d1.files[0].content)).status === 403, `${who}對別人的 uploadId 上傳檔案 → 403`);
    ok((await commit(c, U1)).status === 403, `${who}確認別人的上傳 → 403`);
    ok((await abort(c, U1)).status === 403, `${who}中止別人的上傳 → 403`);
  }
  ok((await req(D, "/api/decks", { origin: null })).status === 401, "未登入（學員）呼叫 GET /api/decks → 401");
  ok((await req(D, "/api/decks", { cookie: T, origin: null })).status === 200, "對照：講師可以呼叫 GET /api/decks");
  for (const action of ["disable", "revoke"]) {
    ok((await manage(null, d1.deck.id, d1.deck.version, action)).status === 403, `未登入${action} → 403`);
    ok((await manage(T, d1.deck.id, d1.deck.version, action)).status === 403, `講師${action} → 403`);
  }

  // ================= 2. Origin =================
  for (const [label, origin] of [["跨 Origin", "https://evil.example"], ["沒有 Origin", null]]) {
    ok((await begin(A, beginBody(makeDeck()), { origin })).status === 403, `${label}開始上傳 → 403`);
    ok((await putFile(A, U1, 0, d1.files[0].content, { origin })).status === 403, `${label}上傳檔案 → 403`);
    ok((await commit(A, U1, { origin })).status === 403, `${label}確認 → 403`);
    ok((await abort(A, U1, { origin })).status === 403, `${label}中止 → 403`);
    ok((await manage(A, d1.deck.id, d1.deck.version, "disable", { origin })).status === 403, `${label}停用 → 403`);
    ok((await manage(A, d1.deck.id, d1.deck.version, "revoke", { origin })).status === 403, `${label}撤銷 → 403`);
  }
  ok((await req(D, `/api/admin/deck-uploads/${U1}/files/0`, { method: "PUT", cookie: A, body: d1.files[0].content, origin: "null" })).status === 403, "Origin 為字串 \"null\" 的上傳 → 403");
  const r2u1 = await r2(A, prefixOf(d1, U1));
  ok(r2u1.length === 0, "被拒的請求都沒有寫入 R2");

  // ================= 6. 單檔上傳 =================
  const p0 = await putFile(A, U1, 0, d1.files[0].content);
  ok(p0.status === 200 && p0.data.already === false, "對照：上傳者以正確 Origin 上傳第 0 個檔");
  ok((await putFile(A, U1, 2, Buffer.from("x"))).status === 400, "index 超出清單範圍 → 400");
  ok((await putFile(A, U1, "-1", Buffer.from("x"))).status === 400, "index 為負數 → 400");
  ok((await putFile(A, U1, "1.5", Buffer.from("x"))).status === 400, "index 非整數 → 400");
  ok((await putFile(A, U1, "01", Buffer.from("x"))).status === 400, "index 有前導零 → 400");
  const chunkedPut = await putFile(A, U1, 1, d1.files[1].content, { chunked: true });
  ok(chunkedPut.status === 411, `缺 Content-Length（分塊傳輸）的單檔上傳 → 411（實際 ${chunkedPut.status}）`);
  const longer = Buffer.concat([d1.files[1].content, Buffer.from("!")]);
  const lenBad = await putFile(A, U1, 1, longer);
  ok(lenBad.status === 400 && lenBad.data.code === "size_mismatch", `Content-Length 與宣告大小不符 → 400（${lenBad.data.code}）`);
  const wrongContent = Buffer.from("X".repeat(d1.files[1].size));
  const shaBad = await putFile(A, U1, 1, wrongContent);
  ok(shaBad.status === 400 && shaBad.data.code === "put_rejected", "內容與 sha256 不符 → 400");
  ok(!(await r2(A, prefixOf(d1, U1))).some((o) => o.key.endsWith("/a.png")), "雜湊不符後 R2 沒有可讀取的 a.png 物件");
  const ctPut = await putFile(A, U1, 1, d1.files[1].content, { headers: { "content-type": "text/html" } });
  ok(ctPut.status === 200, "對照：正確內容的 a.png（用戶端謊稱 text/html）上傳成功");
  const objs1 = await r2(A, prefixOf(d1, U1));
  const png = objs1.find((o) => o.key.endsWith("/a.png"));
  ok(png && png.contentType === "image/png", `Content-Type 由伺服器依副檔名決定（R2 為 ${png?.contentType}），不採用用戶端的 text/html`);
  const idx = objs1.find((o) => o.key.endsWith("/index.html"));
  await sleep(1100);
  const again = await putFile(A, U1, 0, d1.files[0].content);
  const idx2 = (await r2(A, prefixOf(d1, U1))).find((o) => o.key.endsWith("/index.html"));
  ok(again.status === 200 && again.data.already === true, "重送已收到的檔 → 200（already）");
  ok(idx && idx2 && idx.etag === idx2.etag && idx.uploaded === idx2.uploaded, "重送前後 etag 與 uploaded 不變（沒有再寫 R2）");

  // ================= 7. 確認 =================
  const d7 = makeDeck({ extra: ["b.css", "c.js"] });
  const b7 = await begin(A2, beginBody(d7));
  await putFile(A2, b7.data.uploadId, 1, d7.files[1].content);
  const c7 = await commit(A2, b7.data.uploadId);
  ok(c7.status === 409 && JSON.stringify(c7.data.missing) === "[0,2]", `缺檔時確認 → 409，並列出缺少的 index（${JSON.stringify(c7.data.missing)}）`);
  await abort(A2, b7.data.uploadId);
  const c1 = await commit(A, U1);
  ok(c1.status === 200 && c1.data.state === "ready", "全部收到後確認 → ready");
  ok((await commit(A, U1)).status === 200, "已是 ready 時同一位上傳者重送確認 → 200");
  ok((await putFile(A, U1, 0, d1.files[0].content)).status === 409, "對 ready 的上傳送檔 → 409");
  const d1b = makeDeck({ extra: ["z.txt"] });
  const ub = await begin(A, beginBody(d1b));
  await putFile(A, ub.data.uploadId, 0, d1b.files[0].content);
  await putFile(A, ub.data.uploadId, 1, d1b.files[1].content);
  await commit(A, ub.data.uploadId);
  ok((await abort(A, ub.data.uploadId)).status === 409, "abort 已 ready 的上傳 → 409");
  ok((await r2(A, prefixOf(d1b, ub.data.uploadId))).length === 2, "abort 被拒後 R2 物件完好（2 個）");

  // 中止後：送檔、確認都被拒，R2 前綴清空，第二次清理已排程
  const d6 = makeDeck({ extra: ["p.webp", "q.svg"] });
  const b6 = await begin(A, beginBody(d6));
  await putFile(A, b6.data.uploadId, 0, d6.files[0].content);
  ok((await abort(A, b6.data.uploadId)).status === 200, "上傳者可以中止 pending 的上傳");
  ok((await putFile(A, b6.data.uploadId, 1, d6.files[1].content)).status === 409, "對 aborted 的上傳送檔 → 409");
  ok((await commit(A, b6.data.uploadId)).status === 409, "確認 aborted 的上傳 → 409");
  ok(await waitFor(async () => (await r2(A, prefixOf(d6, b6.data.uploadId))).length === 0), "中止後 R2 前綴清空");
  const q6 = await cleanupQueue(A, prefixOf(d6, b6.data.uploadId));
  ok(q6.some((x) => x.reason === "aborted-2"), "中止後第二次清理（10 分鐘後）已排程");

  // ================= 3. 開始上傳的格式 =================
  const fmt = makeDeck();
  const fmtBody = beginBody(fmt);
  const chunkedBegin = await begin(A, fmtBody, { chunked: true });
  ok(chunkedBegin.status === 411, `缺 Content-Length（分塊傳輸）的開始上傳 → 411（實際 ${chunkedBegin.status}）`);
  ok((await begin(A, fmtBody, { headers: { "content-type": "text/plain" } })).status === 415, "Content-Type 不是 JSON → 415");
  const cookieHdr = `cookie: ${A}\r\norigin: ${baseOf(D)}\r\ncontent-type: application/json\r\n`;
  const shortLie = await rawTcp(D, `POST /api/admin/deck-uploads HTTP/1.1\r\nhost: 127.0.0.1:${D.port}\r\n${cookieHdr}content-length: 20\r\nconnection: close\r\n\r\n`, Buffer.from(fmtBody));
  ok(shortLie.status >= 400 && shortLie.status < 500, `謊報長度（宣告比實際短）→ 拒絕（${shortLie.status}）`);
  const longLie = await rawTcp(D, `POST /api/admin/deck-uploads HTTP/1.1\r\nhost: 127.0.0.1:${D.port}\r\n${cookieHdr}content-length: ${Buffer.byteLength(fmtBody) + 500}\r\nconnection: close\r\n\r\n`, Buffer.from(fmtBody));
  ok(longLie.status !== 200, `謊報長度（宣告比實際長、送完即關閉）→ 未建立上傳（${longLie.status || "連線關閉"}）`);
  // 本機 wrangler dev 會等本體送完才轉給 Worker，所以送完整的 600 KiB 非 JSON 本體：回 413（不是 400 JSON 錯誤）表示先依長度拒絕、沒有解析
  const declBig = await begin(A, Buffer.alloc(600 * 1024, 0x7b));
  ok(declBig.status === 413 && declBig.data.code === "body_too_large", `Content-Length 超過 512 KiB（非 JSON 本體）→ 413（${declBig.data.code}）`);
  const huge = JSON.stringify({ deck: fmt.deckText, files: manifest(fmt.files), pad: "x".repeat(520 * 1024) });
  const hugeR = await begin(A, huge);
  ok(hugeR.status === 413, `本體超過 512 KiB → 413（實際 ${hugeR.status}）`);
  // deck.json 以 UTF-8 位元組計：45,000 個中文字＝約 135,000 位元組（字元數未超過 128 Ki，位元組超過）
  const bigDeck = fmt.deckText + " ".repeat(10) + "中".repeat(45000);
  const bigR = await begin(A, JSON.stringify({ deck: bigDeck, files: manifest(fmt.files) }));
  ok(bigR.status === 413 && bigR.data.code === "deck_too_large", `deck.json 超過 128 KiB（UTF-8 位元組）→ 413（${bigR.data.code}）`);
  const bad = await begin(A, JSON.stringify({ deck: fmt.deckText.replace('"contract":1', '"contract":2'), files: manifest(fmt.files) }));
  ok(bad.status === 400 && bad.data.code === "deck_invalid", "deck.json 未通過 src/deck.js 驗證 → 400");
  ok((await begin(A, JSON.stringify({ deck: fmt.deckText, files: manifest(fmt.files), extra: 1 }))).status === 400, "本體有不允許的欄位 → 400");

  // ================= 4. 清單路徑 =================
  const badPaths = ["../x.html", "/abs.html", "a\\b.html", "%2e%2e/x.html", "./a.html", "a/.../b.html", "é.html", "x.exe", "Deck.JSON", "a/b/c/d/e/f/g/h/i.txt", "noext"];
  for (const p of badPaths) {
    const d = makeDeck();
    const files = [...manifest(d.files), { path: p, size: 5, sha256: "a".repeat(64) }];
    const r = await begin(A, beginBody(d, files));
    ok(r.status === 400 && r.data.path === "/files/1/path", `清單路徑 ${JSON.stringify(p)} → 400（${r.data.code}）`);
  }
  {
    const d = makeDeck({ extra: ["img/Logo.png"] });
    const files = [...manifest(d.files), { path: "img/logo.PNG", size: 5, sha256: "a".repeat(64) }];
    const r = await begin(A, beginBody(d, files));
    ok(r.status === 400 && r.data.code === "file_duplicate", "大小寫不同的重複路徑 → 400");
  }
  {
    const d = makeDeck();
    const r = await begin(A, beginBody(d, [{ path: "other.html", size: 5, sha256: "a".repeat(64) }]));
    ok(r.status === 400 && r.data.code === "entry_missing", "entry 不在清單 → 400");
    const d2 = makeDeck({ htmlPages: ["slides/s1.html"] });
    const r2b = await begin(A, beginBody(d2));
    ok(r2b.status === 400 && r2b.data.code === "page_missing", "html 頁的檔案不在清單 → 400");
  }
  {
    const d = makeDeck({ extra: ["__proto__.txt", "constructor/a.txt", "slides/s1.html"], htmlPages: ["slides/s1.html"] });
    const up = await uploadAll(A, d);
    ok(up.b.status === 200, "接受路徑 __proto__.txt、constructor/a.txt（且 html 頁在清單中）");
    const cm = await commit(A, up.uploadId);
    const keys = (await r2(A, prefixOf(d, up.uploadId))).map((o) => o.key.slice(prefixOf(d, up.uploadId).length)).sort();
    ok(cm.status === 200 && JSON.stringify(keys) === JSON.stringify(["__proto__.txt", "constructor/a.txt", "index.html", "slides/s1.html"]), `原型鍵路徑完整上傳並確認（${keys.join(", ")}）`);
    ok((await req(D, "/api/health", { origin: null })).data.ok === true && (await req(D, "/api/decks", { cookie: A, origin: null })).status === 200, "原型鍵路徑沒有污染伺服器（之後的請求照常）");
  }

  // ================= 5. 大小與數量 =================
  {
    const d = makeDeck();
    const many = [...manifest(d.files), ...Array.from({ length: 300 }, (_, i) => ({ path: `f${i}.txt`, size: 1, sha256: "b".repeat(64) }))];
    ok((await begin(A, beginBody(d, many))).data.code === "files_count", "301 個檔 → 拒絕");
    const one = (o) => begin(A, beginBody(d, [...manifest(d.files), { path: "big.mp4", sha256: "c".repeat(64), ...o }]));
    ok((await one({ size: 10 * MB + 1 })).data.code === "file_size", "單檔 10 MB＋1 → 拒絕");
    ok((await one({ size: 0 })).data.code === "file_size", "size 為 0 → 拒絕");
    ok((await one({ size: 1.5 })).data.code === "file_size", "size 為小數 → 拒絕");
    ok((await one({ size: "5" })).data.code === "file_size", "size 為字串 → 拒絕");
    ok((await one({ size: 5, sha256: "C".repeat(64) })).data.code === "file_sha256", "sha256 為大寫十六進位 → 拒絕");
    ok((await one({ size: 5, sha256: "c".repeat(63) })).data.code === "file_sha256", "sha256 長度不對 → 拒絕");
    const sixtyPlus = [...manifest(d.files), ...Array.from({ length: 7 }, (_, i) => ({ path: `m${i}.mp4`, size: 9 * MB, sha256: "d".repeat(64) }))];
    ok((await begin(A, beginBody(d, sixtyPlus))).data.code === "total_size", "總和超過 60 MB → 拒絕");
  }

  // ================= 8. 狀態機：墓碑禁止重用 =================
  {
    const d = makeDeck();
    const up = await uploadAll(A, d);
    await commit(A, up.uploadId);
    ok((await manage(A2, d.deck.id, d.deck.version, "revoke")).status === 200, "另一位管理者可以撤銷 ready 的簡報");
    ok((await begin(A, beginBody(d))).status === 409, "revoke 後用同一個 (id, version) 再開始 → 409");
    ok(await waitFor(async () => (await r2(A, prefixOf(d, up.uploadId))).length === 0), "撤銷後 R2 前綴清空");
    const q = await cleanupQueue(A, prefixOf(d, up.uploadId));
    ok(q.some((x) => x.reason === "revoked-2" && x.due_at > Date.now() + 9 * 60 * 1000) && !q.some((x) => x.reason === "revoked"), `撤銷的第二次清理（約 10 分鐘後）已排程、立即清理已完成（${q.map((x) => x.reason).join(", ")}）`);
    ok((await putFile(A, up.uploadId, 0, d.files[0].content)).status === 409, "對 revoked 的上傳送檔 → 409");
    const da = makeDeck();
    const ba = await begin(A, beginBody(da));
    await abort(A, ba.data.uploadId);
    ok((await begin(A, beginBody(da))).status === 409, "abort 後用同一個 (id, version) 再開始 → 409");
  }

  // ================= 9. 並發 =================
  {
    const d = makeDeck();
    const [x, y] = await Promise.all([begin(A, beginBody(d)), begin(A2, beginBody(d))]);
    const st = [x.status, y.status].sort();
    ok(st[0] === 200 && st[1] === 409, `同一個 (id, version) 同時開始兩次 → 一個成功、一個 409（${x.status}／${y.status}）`);
    const win = x.status === 200 ? [A, x] : [A2, y];
    await abort(win[0], win[1].data.uploadId);
  }

  // ================= 10. 配額 =================
  {
    const mk = () => beginBody(makeDeck());
    const a1 = await begin(A, mk()), a2 = await begin(A, mk());
    const a3 = await begin(A, mk());
    ok(a1.status === 200 && a2.status === 200 && a3.status === 429 && a3.data.code === "quota_pending_user", "同一管理者第 3 個 pending → 拒絕");
    const c1 = await begin(A2, mk()), c2 = await begin(A2, mk()), e1 = await begin(A3, mk());
    const e2 = await begin(A3, mk());
    ok(c1.status === 200 && c2.status === 200 && e1.status === 200 && e2.status === 429 && e2.data.code === "quota_pending_global", "全站第 6 個 pending → 拒絕");
    for (const [c, r] of [[A, a1], [A, a2], [A2, c1], [A2, c2], [A3, e1]]) await abort(c, r.data.uploadId);
    ok((await begin(A, mk())).status === 200, "中止後名額釋放，可以再開始");
    // 總量把 pending 算進去：測試配額調低為 100 MB；先開一個宣告 59 MB 的 pending，再開一個 59 MB → 拒絕；中止前一個後同樣的請求成功
    const pend = (await req(D, "/api/decks", { cookie: A, origin: null })).data; // 只為確認服務正常
    ok(Array.isArray(pend.decks), "列表可用");
    ok((await setClock(A, 0, 100 * MB)).status === 200, "以時鐘接縫把總容量配額調低為 100 MB（只能調低）");
    const big = () => { const d = makeDeck(); return beginBody(d, [...manifest(d.files), ...Array.from({ length: 6 }, (_, i) => ({ path: `v${i}.mp4`, size: Math.floor(59 * MB / 6), sha256: "e".repeat(64) }))]); };
    const g1 = await begin(A2, big());
    const g2body = big();
    const g2 = await begin(A3, g2body);
    ok(g1.status === 200 && g2.status === 413 && g2.data.code === "quota_bytes", "總量把 pending 算進去，超過 → 拒絕");
    await abort(A2, g1.data.uploadId);
    ok((await begin(A3, g2body)).status === 200, "對照：pending 中止後同樣的請求成功");
    ok((await setClock(A, 0, 6 * 1024 * MB)).status === 400, "時鐘接縫不能把配額調高超過 5 GB");
    await setClock(A, 0, null);
  }
  // 配額測試留下的 pending：列表刻意不含 pending，改用時鐘把它們推過逾期，交給 alarm 轉為 aborted
  await setClock(A, 31 * 60 * 1000);
  await sleep(1500);
  await setClock(A, 0);

  // ================= 11. 清理：多個 pending 各自不同的逾期時間 =================
  {
    const dA = makeDeck(), dB = makeDeck();
    const bA = await begin(A, beginBody(dA));
    await putFile(A, bA.data.uploadId, 0, dA.files[0].content);
    await setClock(A, 5 * 60 * 1000);
    const bB = await begin(A2, beginBody(dB));
    await putFile(A2, bB.data.uploadId, 0, dB.files[0].content);
    ok(bB.data.expiresAt - bA.data.expiresAt >= 5 * 60 * 1000 - 5000, "兩個 pending 的逾期時間相差約 5 分鐘");
    ok((await r2(A, prefixOf(dA, bA.data.uploadId))).length === 1 && (await r2(A, prefixOf(dB, bB.data.uploadId))).length === 1, "兩個 pending 各有 1 個 R2 物件");
    await setClock(A, 31 * 60 * 1000); // 只過了第一個的逾期時間
    ok(await waitFor(async () => (await r2(A, prefixOf(dA, bA.data.uploadId))).length === 0), "第一個 pending 逾期後由 alarm 清空");
    ok((await r2(A, prefixOf(dB, bB.data.uploadId))).length === 1, "第二個 pending 尚未逾期，物件仍在");
    await setClock(A, 36 * 60 * 1000);
    ok(await waitFor(async () => (await r2(A, prefixOf(dB, bB.data.uploadId))).length === 0), "第二個 pending 逾期後也被清空");
    ok((await cleanupQueue(A, prefixOf(dB, bB.data.uploadId))).some((x) => x.reason === "expired-2"), "逾期的第二次清理已排程");
    await setClock(A, 48 * 60 * 1000); // 超過第二次清理時間
    ok(await waitFor(async () => (await cleanupQueue(A, prefixOf(dB, bB.data.uploadId))).length === 0), "第二次清理到期後被處理（佇列清空）");
    ok((await putFile(A2, bB.data.uploadId, 1, Buffer.from("x"))).status === 409, "對逾期的上傳送檔 → 409");
    await setClock(A, 0);
  }

  // ================= 8. 狀態機：時鐘讓逾期與 commit 交錯 =================
  {
    // (a) 逾期前一刻 commit → ready，物件完好
    const d = makeDeck({ extra: ["k.json"] });
    const up = await uploadAll(A, d);
    const off = up.b.data.expiresAt - Date.now() - 3000;
    await setClock(A, off);
    const cm = await commit(A, up.uploadId);
    await setClock(A, off + 10 * 60 * 1000);
    await sleep(800);
    const rd = await readyDeck(A, d.deck.id, d.deck.version);
    ok(cm.status === 200 && rd.deck?.upload_id === up.uploadId && (await r2(A, prefixOf(d, up.uploadId))).length === 2, "逾期前 commit → ready；逾期時間過後目錄仍 ready、R2 物件完好");
    await setClock(A, 0);
    // (b) 逾期後 commit → 拒絕，目錄為 aborted，R2 清空
    const d2 = makeDeck({ extra: ["k.json"] });
    const up2 = await uploadAll(A, d2);
    await setClock(A, up2.b.data.expiresAt - Date.now() + 1000);
    const cm2 = await commit(A, up2.uploadId);
    ok(cm2.status === 409, "逾期後 commit → 409");
    ok(await waitFor(async () => (await r2(A, prefixOf(d2, up2.uploadId))).length === 0), "逾期後目錄為 aborted、R2 前綴清空（狀態一致）");
    ok((await readyDeck(A, d2.deck.id, d2.deck.version)).deck === null, "逾期的上傳 getReadyDeck → null");
    await setClock(A, 0);
    // (c) PUT 串流途中逾期：送出一半本體（已通過寫入前檢查、R2 正在接收）後把時鐘推過逾期，再送完 → 409，物件被刪除
    const d3 = makeDeck({ extra: ["slow.mp4"] });
    const slow = Buffer.alloc(4 * MB, 3);
    d3.files[1] = { path: "slow.mp4", size: slow.length, sha256: sha(slow), content: slow };
    const b3 = await begin(A, beginBody(d3));
    const exp3 = b3.data.expiresAt;
    const pending = new Promise((resolve) => {
      const r = http.request({ hostname: "127.0.0.1", port: D.port, path: `/api/admin/deck-uploads/${b3.data.uploadId}/files/1`, method: "PUT", headers: { cookie: A, origin: baseOf(D), "content-length": slow.length } }, (res) => {
        let t = ""; res.on("data", (x) => (t += x)); res.on("end", () => resolve({ status: res.statusCode, text: t }));
      });
      r.on("error", (e) => resolve({ status: 0, text: e.message }));
      r.write(slow.subarray(0, 2 * MB));
      setTimeout(async () => { await setClock(A, exp3 - Date.now() + 1000); r.end(slow.subarray(2 * MB)); }, 800);
    });
    const res3 = await pending;
    let j3 = {}; try { j3 = JSON.parse(res3.text); } catch {}
    // 寫入前檢查的 409 會附 state；「記錄已收到前的再檢查」的 409 不附：確認這次走的是 R2 寫入後的再檢查
    ok(res3.status === 409 && j3.code === "not_pending" && j3.state === undefined, `串流途中逾期 → R2 寫入後、記錄已收到前的再檢查回 409（${res3.status} ${j3.code}）`);
    ok(await waitFor(async () => (await r2(A, prefixOf(d3, b3.data.uploadId))).length === 0), "串流途中逾期：R2 沒有留下物件");
    await setClock(A, 0);
  }

  // ================= 12. 列表 ／ 14. getReadyDeck =================
  {
    const dr = makeDeck(), dd = makeDeck(), dp = makeDeck(), dab = makeDeck(), drv = makeDeck();
    const ur = await uploadAll(A, dr); await commit(A, ur.uploadId);
    const ud = await uploadAll(A, dd); await commit(A, ud.uploadId);
    ok((await manage(A2, dd.deck.id, dd.deck.version, "disable")).status === 200, "另一位管理者可以停用 ready 的簡報");
    const up = await begin(A, beginBody(dp));
    const ua = await begin(A2, beginBody(dab)); await abort(A2, ua.data.uploadId);
    const uv = await uploadAll(A2, drv); await commit(A2, uv.uploadId); await manage(A, drv.deck.id, drv.deck.version, "revoke");
    const adminList = (await req(D, "/api/decks", { cookie: A, origin: null })).data.decks;
    const presList = (await req(D, "/api/decks", { cookie: T, origin: null })).data.decks;
    const has = (list, d) => list.some((x) => x.id === d.deck.id && x.version === d.deck.version);
    // 內建簡報（方案 B）的項目多一個 builtin: true 標記；簡報庫項目仍只能有這 5 個欄位
    const keysOk = adminList.every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(x.builtin === true
      ? ["builtin", "created_at", "id", "state", "title", "version"] : ["created_at", "id", "state", "title", "version"]));
    ok(keysOk && !JSON.stringify(adminList).includes("uploaded_by") && !JSON.stringify(adminList).includes("files_json"), "列表只有 id、version、title、state、created_at（不含 uploaded_by、files_json）");
    ok(has(adminList, dr) && has(adminList, dd) && !has(adminList, dp) && !has(adminList, dab) && !has(adminList, drv), "管理者列表含 ready 與 disabled，不含 pending 與墓碑");
    ok(has(presList, dr) && !has(presList, dd) && presList.every((x) => x.state === "ready"), "講師列表只有 ready，看不到 disabled");
    ok(adminList.length <= 200, "列表最多 200 列");
    const rr = await readyDeck(A, dr.deck.id, dr.deck.version);
    ok(rr.deck?.upload_id === ur.uploadId && rr.deck?.title === dr.deck.title && Object.keys(rr.deck).length === 2, "getReadyDeck：ready 回傳正確的 upload_id（端點只回 upload_id 與 title）");
    ok((await readyDeck(A, dd.deck.id, dd.deck.version)).deck === null, "getReadyDeck：disabled → null");
    ok((await readyDeck(A, dp.deck.id, dp.deck.version)).deck === null, "getReadyDeck：pending → null");
    ok((await readyDeck(A, dab.deck.id, dab.deck.version)).deck === null, "getReadyDeck：aborted → null");
    ok((await readyDeck(A, drv.deck.id, drv.deck.version)).deck === null, "getReadyDeck：revoked → null");
    ok((await readyDeck(A, "no-such-deck", "1")).deck === null, "getReadyDeck：不存在 → null");
    ok((await manage(A, dp.deck.id, dp.deck.version, "disable")).status === 409 && (await manage(A, dp.deck.id, dp.deck.version, "revoke")).status === 409, "pending 不能停用或撤銷（409）");
    await abort(A, up.data.uploadId);
    ok((await manage(A, dd.deck.id, dd.deck.version, "revoke")).status === 200, "已停用的簡報可以撤銷");
  }

  // ================= 13. 開發用端點的把關 =================
  {
    const dev = [
      ["GET", "/api/dev/clock"], ["POST", "/api/dev/clock"], ["GET", "/api/dev/r2?prefix=decks/"],
      ["GET", "/api/dev/catalog/ready-deck?id=x&version=1"], ["GET", "/api/dev/catalog/cleanup?prefix=decks/"],
    ];
    const P = INSTANCES.prod, N = INSTANCES.noflag;
    const NA = await (async () => (await req(N, "/api/dev/login", { method: "POST", body: { email: ADMINS[0] }, headers: { "content-type": "application/json" } })).cookie)();
    ok(!!NA, "對照：未開旗標的開發實例仍可用開發登入取得管理者 cookie");
    ok((await req(P, "/api/dev/login", { method: "POST", body: { email: ADMINS[0] }, headers: { "content-type": "application/json" } })).status === 404, "對照：正式模式實例的開發登入 → 404");
    for (const [m, p] of dev) {
      const body = m === "POST" ? { offsetMs: 0 } : undefined;
      const h = m === "POST" ? { "content-type": "application/json" } : {};
      ok((await req(D, p, { method: m, cookie: A, body, headers: h })).status === 200, `對照：開發實例＋管理者 ${m} ${p.split("?")[0]} → 200`);
      ok((await req(P, p, { method: m, cookie: A, body, headers: h })).status === 404, `正式環境 ${m} ${p.split("?")[0]} → 404`);
      ok((await req(D, p, { method: m, cookie: A, body, headers: h, host: "example.com", origin: "http://example.com" })).status === 404, `非迴環主機名（管理者）${m} ${p.split("?")[0]} → 404`);
      ok((await req(N, p, { method: m, cookie: NA, body, headers: h })).status === 404, `沒開對應旗標（管理者）${m} ${p.split("?")[0]} → 404`);
      ok((await req(D, p, { method: m, cookie: T, body, headers: h })).status === 404, `講師 ${m} ${p.split("?")[0]} → 404`);
      ok((await req(D, p, { method: m, body, headers: h })).status === 404, `未登入 ${m} ${p.split("?")[0]} → 404`);
    }
  }
} catch (e) {
  ok(false, `測試中斷：${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
} finally {
  stopAll();
}

console.log(failed ? `\n${failed} 項失敗（${passed} 項通過）` : `\n全部通過（${passed} 項）`);
process.exit(failed ? 1 : 0);
