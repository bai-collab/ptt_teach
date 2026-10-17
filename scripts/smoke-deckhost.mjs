// 簡報主機（S3d-B）冒煙測試：用 Node 驗證簡報主機 Worker（deck-host/）與主站的隔離設定。
// 自己啟動所需的 wrangler dev 實例，記錄 PID，測完只關自己的程序樹（taskkill /T）；不碰 8791／8801／8811／8812。
//   - 主站（開發）    127.0.0.1:8831  ENVIRONMENT=development、DEV_LOGIN=1、DECK_ORIGIN=http://127.0.0.1:8832
//   - 簡報主機        127.0.0.1:8832  只綁主站的 Catalog DO（script_name）與 R2 DECKS
//     兩者共用 --persist-to .wrangler/smoke-deckhost（同一份本機 R2），並以 WRANGLER_REGISTRY_PATH 指向專用的 dev registry，
//     避免連到使用者自己開的 ptt-teach 實例。
//   - 主站（正式模式）127.0.0.1:8833  ENVIRONMENT=production、DECK_ORIGIN=https://decks.example.test（另一個 registry 與資料目錄）
// 用法：node scripts/smoke-deckhost.mjs
// 另匯出 startStack()／uploadDeckDir() 等工具，供 scripts/e2e-isolation.mjs 共用。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (b) => createHash("sha256").update(b).digest("hex");
export const ADMIN = "admin@example.test";

// ---- HTTP：node:http 才能送出原樣的路徑（不經 URL 正規化）並控制標頭 ----
export function req(base, path, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(base);
  const h = { ...headers };
  const buf = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  if (buf) h["content-length"] = buf.length;
  return new Promise((resolve) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path, method, headers: h, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("utf8");
        let data = null; try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, text, data });
      });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, headers: {}, raw: Buffer.alloc(0), text: e.message, data: null }));
    if (buf) r.write(buf);
    r.end();
  });
}
const portBusy = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("connect", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

// ---- 啟動實例（只關自己記錄的 PID 樹）----
function startWrangler(args, env) {
  const p = spawn(process.execPath, [wranglerJs, "dev", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  p.log = () => log;
  return p;
}
const killTree = (p) => { if (p?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" }); };

/**
 * 啟動主站（開發）＋簡報主機，選用正式模式主站。回傳 { mainBase, mainLocal, deckBase, prodBase, stop }。
 * mainLocal 是以 localhost 開主站的網址（與簡報主機 127.0.0.1 主機名不同＝不同站）。
 */
export async function startStack({ tag, mainPort = 8831, deckPort = 8832, prodPort = null }) {
  const ports = [mainPort, deckPort, ...(prodPort ? [prodPort] : [])];
  for (const p of ports) if (await portBusy(p)) throw new Error(`${p} 埠已被其他程序使用（不會關閉別人的程序）`);
  const persist = `.wrangler/${tag}`;
  const registry = join(root, ".wrangler", `registry-${tag}`);
  for (const d of [join(root, persist), registry, join(root, `.wrangler/${tag}-prod`), join(root, ".wrangler", `registry-${tag}-prod`)]) rmSync(d, { recursive: true, force: true });
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_REGISTRY_PATH: registry };
  const deckOrigin = `http://127.0.0.1:${deckPort}`;
  const procs = [];
  const stop = () => { for (const p of procs) killTree(p); };
  try {
    procs.push(startWrangler(["--ip", "127.0.0.1", "--port", String(mainPort), "--persist-to", persist,
      "--var", "ENVIRONMENT:development", "--var", "DEV_LOGIN:1", "--var", `ADMIN_EMAILS:${ADMIN}`, "--var", `DECK_ORIGIN:${deckOrigin}`], env));
    // 簡報主機只讀 deck-host/ 旁的 .dev.vars（不存在），所以明確傳入開發模式與主站 origin（瀏覽器以 localhost 開主站），不依賴預設值
    procs.push(startWrangler(["-c", "deck-host/wrangler.toml", "--ip", "127.0.0.1", "--port", String(deckPort), "--persist-to", persist,
      "--var", "ENVIRONMENT:development", "--var", `MAIN_ORIGIN:http://localhost:${mainPort}`], env));
    if (prodPort) {
      const envProd = { ...env, WRANGLER_REGISTRY_PATH: join(root, ".wrangler", `registry-${tag}-prod`) };
      procs.push(startWrangler(["--ip", "127.0.0.1", "--port", String(prodPort), "--persist-to", `.wrangler/${tag}-prod`,
        "--var", "ENVIRONMENT:production", "--var", "DECK_ORIGIN:https://decks.example.test"], envProd));
    }
    const mainBase = `http://127.0.0.1:${mainPort}`;
    const prodBase = prodPort ? `http://127.0.0.1:${prodPort}` : null;
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      await sleep(1000);
      const a = await req(mainBase, "/api/health");
      const b = await req(deckOrigin, "/");
      const c = prodBase ? await req(prodBase, "/api/health") : { data: { app: "ptt-teach" } };
      // 簡報主機要等到 Catalog 綁定連上（log 出現 [connected]）
      up = a.data?.app === "ptt-teach" && b.status === 404 && c.data?.app === "ptt-teach" && /env\.CATALOG[^\n]*\[connected\]/.test(procs[1].log());
    }
    if (!up) throw new Error("實例未就緒：\n" + procs.map((p) => p.log().slice(-600)).join("\n----\n"));
    return { mainBase, mainLocal: `http://localhost:${mainPort}`, mainOrigin: `http://localhost:${mainPort}`, deckBase: deckOrigin, prodBase, stop, pids: procs.map((p) => p.pid) };
  } catch (e) { stop(); throw e; }
}

export async function adminLogin(mainBase) {
  const r = await req(mainBase, "/api/dev/login", { method: "POST", headers: { "content-type": "application/json" }, body: { email: ADMIN } });
  const set = r.headers["set-cookie"];
  if (r.status !== 200 || !set) throw new Error("管理者登入失敗：" + r.status + " " + r.text);
  return String(set[0]).split(";")[0];
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.filter((p) => p !== "deck.json").sort();
}
/**
 * 以真實三步 API 上傳一個簡報資料夾（開始 → 逐檔 PUT → 確認）。overrides 可改 deck.json 的 id／version／title。
 * commit=false 時只開始上傳並送出第一個檔案（留在 pending）。回傳 { uploadId, id, version, files }。
 */
export async function uploadDeckDir(mainBase, cookie, dir, { overrides = {}, commit = true } = {}) {
  const deck = { ...JSON.parse(readFileSync(join(dir, "deck.json"), "utf8")), ...overrides };
  const files = listFiles(dir).map((path) => { const content = readFileSync(join(dir, path)); return { path, size: content.length, sha256: sha(content), content }; });
  const origin = new URL(mainBase).origin;
  const b = await req(mainBase, "/api/admin/deck-uploads", { method: "POST", headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ deck: JSON.stringify(deck), files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) }) });
  if (b.status !== 200) throw new Error(`開始上傳失敗 ${b.status} ${b.text}`);
  const uploadId = b.data.uploadId;
  const n = commit ? files.length : 1;
  for (let i = 0; i < n; i++) {
    const p = await req(mainBase, `/api/admin/deck-uploads/${uploadId}/files/${i}`, { method: "PUT", headers: { cookie, origin }, body: files[i].content });
    if (p.status !== 200) throw new Error(`上傳 ${files[i].path} 失敗 ${p.status} ${p.text}`);
  }
  if (commit) {
    const c = await req(mainBase, `/api/admin/deck-uploads/${uploadId}/commit`, { method: "POST", headers: { cookie, origin } });
    if (c.status !== 200 || c.data?.state !== "ready") throw new Error(`確認失敗 ${c.status} ${c.text}`);
  }
  return { uploadId, id: deck.id, version: deck.version, files, deck };
}
export async function manageDeck(mainBase, cookie, id, version, action) {
  return req(mainBase, `/api/admin/decks/${id}/${version}/${action}`, { method: "POST", headers: { cookie, origin: new URL(mainBase).origin } });
}
export async function createRoom(mainBase, cookie, body = {}) {
  return req(mainBase, "/api/rooms", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body });
}
// CSP 字串 → Map(指令 → 值)
export function cspDirectives(csp) {
  const m = new Map();
  for (const part of String(csp || "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    const i = t.indexOf(" ");
    m.set(i < 0 ? t : t.slice(0, i), i < 0 ? "" : t.slice(i + 1).trim());
  }
  return m;
}

// 簡報主機的預期標頭（契約 §4，S4-A）：測試端獨立寫出完整字串，不從 deck-host/src/index.js 匯入（才抓得到實作被改）
export function expectedDeckCsp(d, ancestors) {
  return `sandbox allow-scripts; default-src 'none'; script-src ${d} 'unsafe-inline'; style-src ${d} 'unsafe-inline' https://fonts.googleapis.com; ` +
    `font-src ${d} data: https://fonts.gstatic.com; img-src ${d} data: blob:; media-src ${d} blob:; connect-src ${d}; frame-src 'none'; ` +
    `worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${ancestors}`;
}
export const EXPECTED_PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), hid=(), serial=(), midi=(), " +
  "payment=(), fullscreen=(), clipboard-read=(), clipboard-write=()";

// ===================== S4-A：簡報主機 MAIN_ORIGIN 判定與靜態檢查（不需啟動實例）=====================
// 直接在 Node 載入 deck-host/src/index.js（與 wrangler 執行的是同一份程式），用假的 env 呼叫 fetch，
// 檢查每種 MAIN_ORIGIN／ENVIRONMENT／請求主機名組合的 frame-ancestors，以及 404／405／503／HEAD 也帶完整 CSP。
async function deckHostUnitChecks(ok) {
  const mod = await import(pathToFileURL(join(root, "deck-host", "src", "index.js")).href);
  const worker = mod.default;
  const call = async (url, env, method = "GET") => worker.fetch(new Request(url, { method }), env);
  const fa = (res) => cspDirectives(res.headers.get("content-security-policy")).get("frame-ancestors");
  const LOOP = "http://127.0.0.1:8832", PROD = "https://decks.example.test";
  const cases = [
    // [標籤, 請求網址, env, 預期 frame-ancestors]
    ["正式：MAIN_ORIGIN 是萬用字元 *", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "*" }, "'none'"],
    ["正式：MAIN_ORIGIN 含萬用字元子網域", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://*.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 是 https:（只有 scheme）", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https:" }, "'none'"],
    ["正式：MAIN_ORIGIN 以空白分隔多個值", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://a.example.test https://b.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 以逗號分隔多個值", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://a.example.test,https://b.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 夾分號（嘗試注入指令）", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://a.example.test; script-src *" }, "'none'"],
    ["正式：MAIN_ORIGIN 用 http", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "http://main.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 等於簡報主機自己", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: PROD }, "'none'"],
    ["正式：MAIN_ORIGIN 帶路徑／結尾斜線", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://main.example.test/" }, "'none'"],
    ["正式：MAIN_ORIGIN 帶帳密", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://u:p@main.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 大寫（未正規化）", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://MAIN.example.test" }, "'none'"],
    ["正式：MAIN_ORIGIN 是 'self'", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "'self'" }, "'none'"],
    ["正式：未設定 MAIN_ORIGIN", PROD, { ENVIRONMENT: "production" }, "'none'"],
    ["正式＋迴環主機名：未設定 MAIN_ORIGIN（開發預設不生效）", LOOP, { ENVIRONMENT: "production" }, "'none'"],
    ["未設 ENVIRONMENT＋迴環主機名：未設定 MAIN_ORIGIN", LOOP, {}, "'none'"],
    ["development＋非迴環主機名：未設定 MAIN_ORIGIN（開發預設不生效）", PROD, { ENVIRONMENT: "development" }, "'none'"],
    ["development＋非迴環主機名：MAIN_ORIGIN 用 http", PROD, { ENVIRONMENT: "development", MAIN_ORIGIN: "http://localhost:8801" }, "'none'"],
    ["development＋迴環：MAIN_ORIGIN 與簡報主機同主機名（不同埠）", LOOP, { ENVIRONMENT: "development", MAIN_ORIGIN: "http://127.0.0.1:8831" }, "'none'"],
    ["development＋迴環：MAIN_ORIGIN 等於簡報主機自己", LOOP, { ENVIRONMENT: "development", MAIN_ORIGIN: LOOP }, "'none'"],
    ["對照：development＋迴環（127.0.0.1）未設定 → 開發預設", LOOP, { ENVIRONMENT: "development" }, "http://localhost:8801"],
    ["development＋迴環（localhost 主機名）未設定：開發預設 http://localhost:8801 與簡報主機同主機名", "http://localhost:8832", { ENVIRONMENT: "development" }, "'none'"],
    ["對照：development＋迴環：明確 MAIN_ORIGIN", LOOP, { ENVIRONMENT: "development", MAIN_ORIGIN: "http://localhost:8841" }, "http://localhost:8841"],
    ["對照：正式：合格的 https MAIN_ORIGIN", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "https://main.example.test" }, "https://main.example.test"],
    ["對照：正式：MAIN_ORIGIN 前後空白（trim 後合格）", PROD, { ENVIRONMENT: "production", MAIN_ORIGIN: "  https://main.example.test  " }, "https://main.example.test"],
  ];
  for (const [label, url, env, want] of cases) {
    const r = await call(`${url}/`, env);
    const got = fa(r);
    const d = new URL(url).origin;
    ok(r.status === 404 && got === want && r.headers.get("content-security-policy") === expectedDeckCsp(d, want),
      `MAIN_ORIGIN 判定｜${label} → frame-ancestors ${want}（實際：${got}），其餘 CSP 完全相同`);
  }
  // 每種回應都帶完整 CSP 與其他標頭（405、HEAD 404、503）
  const env = { ENVIRONMENT: "production", MAIN_ORIGIN: "https://main.example.test" };
  const want = expectedDeckCsp(PROD, "https://main.example.test");
  const full = (r) => r.headers.get("content-security-policy") === want && r.headers.get("x-dns-prefetch-control") === "off" &&
    r.headers.get("permissions-policy") === EXPECTED_PERMISSIONS_POLICY && r.headers.get("x-content-type-options") === "nosniff";
  const r405 = await call(`${PROD}/${"a".repeat(32)}/index.html`, env, "POST");
  ok(r405.status === 405 && full(r405), "POST → 405 也帶完整 CSP、X-DNS-Prefetch-Control、Permissions-Policy");
  const rHead = await call(`${PROD}/nope`, env, "HEAD");
  ok(rHead.status === 404 && full(rHead), "HEAD 404 也帶完整 CSP 與其他標頭");
  const broken = { ...env, CATALOG: { idFromName() { throw new Error("down"); }, get() { throw new Error("down"); } } };
  const r503 = await call(`${PROD}/${"a".repeat(32)}/index.html`, broken);
  ok(r503.status === 503 && full(r503), "目錄無法連線 → 503 也帶完整 CSP 與其他標頭");

  // ---- 靜態檢查：index.js 的 CSP 不受任何 env 分支影響（MAIN_ORIGIN 除外）----
  const src = readFileSync(join(root, "deck-host", "src", "index.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const envRefs = [...new Set([...code.matchAll(/\benv\s*\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
  ok(envRefs.join(",") === "ASSETS,CATALOG,DECKS,MAIN_ORIGIN", `index.js 只讀取 env.ASSETS／CATALOG／DECKS／MAIN_ORIGIN（實際：${envRefs.join(",")}）`);
  ok(!/\benv\s*\[/.test(code) && !/\{[^}]*\}\s*=\s*env\b/.test(code) && !/Object\.(keys|entries|values)\(\s*env/.test(code), "index.js 沒有以 env[...]、解構或列舉方式讀取其他設定");
  const cspFn = code.slice(code.indexOf("function deckHostCsp"), code.indexOf("\n}", code.indexOf("function deckHostCsp")));
  ok(cspFn.length > 0 && !/\benv\b/.test(cspFn) && /function deckHostCsp\(d, ancestors\)/.test(cspFn), "deckHostCsp(d, ancestors) 不接收也不讀取 env");
  const devUse = [...code.matchAll(/devOnlyAllowed\(/g)].length;
  const faFn = code.slice(code.indexOf("function frameAncestorsFor"), code.indexOf("\n}", code.indexOf("function frameAncestorsFor")));
  ok(devUse === 1 && faFn.includes("devOnlyAllowed(env, url.hostname)"), "ENVIRONMENT 只經由 frameAncestorsFor 內的 devOnlyAllowed 影響 MAIN_ORIGIN 預設值");
  ok(!/unsafe-eval/.test(code) && !/DISABLE|BYPASS|LOOSE|NO_CSP|CSP_OFF/i.test(code), "index.js 沒有 'unsafe-eval'，也沒有停用或放寬 CSP 的旗標名稱");

  // ---- 靜態比對：README 的手動啟動簡報主機指令 ----
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const deckLines = readme.split(/\r?\n/).filter((l) => /wrangler dev -c deck-host\/wrangler\.toml/.test(l));
  ok(deckLines.length >= 1 && deckLines.every((l) => l.includes("--var ENVIRONMENT:development") && l.includes("--var MAIN_ORIGIN:http://localhost:8801")),
    `README 手動啟動簡報主機的指令含 ENVIRONMENT:development 與 MAIN_ORIGIN:http://localhost:8801（${deckLines.length} 行）`);
}

// ===================== 測試本體（直接執行時）=====================
async function main() {
  let failed = 0, passed = 0;
  const ok = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (c) passed++; else failed++; };
  await deckHostUnitChecks(ok);
  const RUN = Date.now().toString(36);
  const stack = await startStack({ tag: "smoke-deckhost", mainPort: 8831, deckPort: 8832, prodPort: 8833 });
  console.log(`實例：主站 ${stack.mainBase}（PID ${stack.pids[0]}）、簡報主機 ${stack.deckBase}（PID ${stack.pids[1]}）、正式模式主站 ${stack.prodBase}（PID ${stack.pids[2]}）`);
  try {
    const M = stack.mainBase, D = stack.deckBase;
    // 瀏覽器實際以 localhost 開主站（與簡報主機 127.0.0.1 不同主機名）；以 Host 標頭模擬，連線仍走 127.0.0.1
    const LH = { host: `localhost:${new URL(M).port}` };
    const reqL = (path, opts = {}) => req(M, path, { ...opts, headers: { ...LH, ...(opts.headers || {}) } });
    const A = await adminLogin(M);
    const sampleDir = join(root, "examples", "decks", "ai-era-education");
    const multiDir = join(root, "examples", "decks", "multi-file-test");

    // ---- 準備：真實 API 上傳 ----
    const sample = await uploadDeckDir(M, A, sampleDir);
    const multi = await uploadDeckDir(M, A, multiDir);
    ok(/^[0-9a-f]{32}$/.test(sample.uploadId) && /^[0-9a-f]{32}$/.test(multi.uploadId), "範例簡報與多檔測試簡報經真實三步 API 上傳為 ready");
    const pending = await uploadDeckDir(M, A, multiDir, { overrides: { id: "dh-pending", version: `v${RUN}` }, commit: false });
    const revoked = await uploadDeckDir(M, A, multiDir, { overrides: { id: "dh-revoked", version: `v${RUN}` } });
    const disabled = await uploadDeckDir(M, A, multiDir, { overrides: { id: "dh-disabled", version: `v${RUN}` } });
    ok((await req(D, `/${revoked.uploadId}/index.html`)).status === 200, "對照：撤銷前簡報主機可提供該簡報");
    ok((await manageDeck(M, A, revoked.id, revoked.version, "revoke")).data?.state === "revoked", "撤銷一份簡報");
    ok((await manageDeck(M, A, disabled.id, disabled.version, "disable")).data?.state === "disabled", "停用一份簡報");

    // ---- 1. 直接開啟簡報網址：標頭（S4-A：每種回應的 CSP 都完全等於契約 §4 的字串）----
    const EXPECT_CSP = expectedDeckCsp(D, stack.mainOrigin);
    const HDR = { "content-security-policy": EXPECT_CSP, "x-content-type-options": "nosniff", "access-control-allow-origin": "*",
      "x-dns-prefetch-control": "off", "permissions-policy": EXPECTED_PERMISSIONS_POLICY };
    const hasSecHeaders = (r) => Object.entries(HDR).every(([k, v]) => r.headers[k] === v);
    const entry = await req(D, `/${multi.uploadId}/index.html?embed=1`, { headers: { cookie: "aee_s=should-not-be-read" } });
    ok(entry.status === 200 && hasSecHeaders(entry), "直接開啟簡報網址：200，CSP 完全等於契約 §4、帶 X-DNS-Prefetch-Control: off、Permissions-Policy、nosniff、CORS *");
    if (entry.headers["content-security-policy"] !== EXPECT_CSP) console.log(`   實際 CSP：${entry.headers["content-security-policy"]}\n   預期 CSP：${EXPECT_CSP}`);
    // 個別指令（mutant 對照用：拿掉任一項時對應這一行失敗）
    const entryCsp = cspDirectives(entry.headers["content-security-policy"]);
    ok(entryCsp.get("frame-ancestors") === stack.mainOrigin, `startStack 的簡報主機：frame-ancestors 完全等於 ${stack.mainOrigin}（不是 'none'；實際：${entryCsp.get("frame-ancestors")}）`);
    ok(entryCsp.get("connect-src") === D, `簡報主機 connect-src 完全等於 ${D}（實際：${entryCsp.get("connect-src")}）`);
    ok(entryCsp.get("base-uri") === "'none'", `簡報主機 base-uri 為 'none'（實際：${entryCsp.get("base-uri")}）`);
    ok(entryCsp.get("form-action") === "'none'" && entryCsp.get("frame-src") === "'none'" && entryCsp.get("worker-src") === "'none'" && entryCsp.get("object-src") === "'none'" && entryCsp.get("default-src") === "'none'",
      "簡報主機 default-src／frame-src／worker-src／object-src／form-action 都是 'none'");
    ok(!/unsafe-eval|\*/.test(entry.headers["content-security-policy"] || "x*"), "簡報主機 CSP 沒有 'unsafe-eval'、沒有萬用字元");
    ok(entry.headers["content-type"] === "text/html; charset=utf-8", "entry 的 Content-Type 為 text/html; charset=utf-8");
    ok(entry.headers["set-cookie"] === undefined, "簡報主機回應沒有 Set-Cookie（即使請求帶了 Cookie）");
    ok(sha(entry.raw) === multi.files.find((f) => f.path === "index.html").sha256, "回傳內容與上傳的檔案位元組相同");
    const EXPECT_CT = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", txt: "text/plain; charset=utf-8" };
    let allTypes = true, allBytes = true, allHdr = true, noCookie = true;
    for (const f of multi.files) {
      const r = await req(D, `/${multi.uploadId}/${f.path}`);
      const ext = f.path.slice(f.path.lastIndexOf(".") + 1);
      if (r.status !== 200 || r.headers["content-type"] !== EXPECT_CT[ext]) { allTypes = false; console.log(`   ${f.path} → ${r.status} ${r.headers["content-type"]}`); }
      if (sha(r.raw) !== f.sha256) allBytes = false;
      if (!hasSecHeaders(r)) allHdr = false;
      if (r.headers["set-cookie"] !== undefined) noCookie = false;
    }
    ok(allTypes, `多檔簡報 ${multi.files.length} 個檔案的 Content-Type 都依副檔名決定（文字類加 charset=utf-8）`);
    ok(allBytes && allHdr && noCookie, "多檔簡報每個檔案：內容正確、CSP 與其他安全標頭完全相符、沒有 Set-Cookie");
    const head = await req(D, `/${multi.uploadId}/css/style.css`, { method: "HEAD" });
    ok(head.status === 200 && head.raw.length === 0 && hasSecHeaders(head) && head.headers["content-type"] === "text/css; charset=utf-8", "HEAD：200、沒有本體、標頭相同");
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const r = await req(D, `/${multi.uploadId}/index.html`, { method, body: method === "POST" || method === "PUT" ? "x" : undefined });
      ok(r.status === 405 && hasSecHeaders(r) && r.headers.allow === "GET, HEAD", `${method} → 405（帶安全標頭與 Allow: GET, HEAD）`);
    }

    // ---- 4. 路徑與狀態：一律 404 ----
    const U = multi.uploadId;
    const other = sample.uploadId;
    const notFoundPaths = [
      [`/${U}/%2e%2e/%2e%2e/deck.json`, "%2e%2e 跳出（deck.json）"],
      [`/${U}/%2e%2e/index.html`, "%2e%2e 跳到 uploadId 之外"],
      [`/${U}/%2E%2E/%2E%2E/decks/${multi.id}/${multi.version}/${U}/index.html`, "%2E%2E 大寫，嘗試組出 R2 鍵"],
      [`/${U}/..%2fdeck.json`, "..%2f"],
      [`/${U}/%2e%2e%2f${other}%2findex.html`, "%2e%2e%2f 編碼斜線"],
      [`/${U}/css%2fstyle.css`, "%2f 編碼斜線"],
      [`/${U}/%69ndex.html`, "百分比編碼的一般字元（不解碼）"],
      [`/${U}/index.html%00`, "%00"],
      [`/${U}/deck.json`, "deck.json（不在清單）"],
      [`/${U}/secret.html`, "不在清單的檔案"],
      [`/${U}/Index.html`, "大小寫不同"],
      [`/${U}/index.html/`, "結尾斜線"],
      [`/${U}/js`, "資料夾"],
      [`/${U}/`, "只有 uploadId"],
      [`/${U.toUpperCase()}/index.html`, "大寫 uploadId"],
      [`/${U.slice(1)}/index.html`, "31 位 uploadId"],
      [`/decks/${multi.id}/${multi.version}/${U}/index.html`, "直接用 R2 鍵當網址"],
      [`/${"0".repeat(32)}/index.html`, "不存在的 uploadId"],
      [`/${pending.uploadId}/index.html`, "pending（已寫入 R2 的第一個檔）"],
      [`/${revoked.uploadId}/index.html`, "revoked"],
      [`/${revoked.uploadId}/js/main.js`, "revoked（其他檔）"],
      [`/${U}/index.html\\..\\deck.json`, "反斜線"],
    ];
    for (const [p, label] of notFoundPaths) {
      const r = await req(D, p);
      ok(r.status === 404 && hasSecHeaders(r) && r.headers["set-cookie"] === undefined, `404：${label}（${p.length > 70 ? p.slice(0, 70) + "…" : p}）`);
    }
    // 資訊項：在同一份簡報內的 %2e%2e（URL 正規化後仍落在本簡報清單內）
    const inside = await req(D, `/${U}/css/%2e%2e/index.html`);
    console.log(`INFO  /${U.slice(0, 6)}…/css/%2e%2e/index.html → ${inside.status}（執行環境先正規化網址；結果仍限於同一份 ready 簡報的清單檔）`);
    const dis = await req(D, `/${disabled.uploadId}/index.html`);
    ok(dis.status === 200, "disabled 的簡報：既有場次照常可讀（resolveAsset 允許 ready／disabled）");

    // ---- 3. live 頁 CSP（S4-A）：frame-src 只有精確的簡報主機 origin；connect-src 只有 'self'＋精確 ws origin ----
    const mainPort = new URL(M).port;
    const live = await reqL("/live?code=ABCDEF");
    const liveCsp = cspDirectives(live.headers["content-security-policy"]);
    ok(live.status === 200 && liveCsp.get("frame-src") === D, `live 頁（localhost）frame-src 完全等於 ${D}（不含 'self'；實際：${liveCsp.get("frame-src")}）`);
    ok(liveCsp.get("connect-src") === `'self' ws://localhost:${mainPort}`, `live 頁 connect-src 完全等於 'self' ws://localhost:${mainPort}（沒有 ws:／wss: 萬用字元、沒有 gsi；實際：${liveCsp.get("connect-src")}）`);
    ok(!String(liveCsp.get("frame-src")).includes("*"), "live 頁 frame-src 沒有萬用字元");
    ok([...String(live.headers["content-security-policy"]).matchAll(/frame-src/g)].length === 1 && !Array.isArray(live.headers["content-security-policy"]), "live 頁只有一個 CSP 標頭、一個 frame-src");
    const liveHtml = await reqL("/live.html?code=ABCDEF");
    const liveHtmlCsp = cspDirectives(liveHtml.headers["content-security-policy"]);
    ok(liveHtml.status === 307 && liveHtmlCsp.get("frame-src") === D && liveHtmlCsp.get("connect-src") === `'self' ws://localhost:${mainPort}`, "/live.html（轉址到 /live）同樣帶精確 frame-src 與 connect-src");
    const live127 = await req(M, "/live?code=ABCDEF");
    const live127Csp = cspDirectives(live127.headers["content-security-policy"]);
    ok(live127Csp.get("frame-src") === "'none'", `主站用 127.0.0.1 開（與簡報主機同主機名）→ fail closed：frame-src 'none'（實際：${live127Csp.get("frame-src")}）`);
    ok(live127Csp.get("connect-src") === `'self' ws://127.0.0.1:${mainPort}`, "主站用 127.0.0.1 開：connect-src 的 ws origin 跟著請求主機（精確值）");
    const liveProd = await req(stack.prodBase, "/live?code=ABCDEF");
    const liveProdCsp = cspDirectives(liveProd.headers["content-security-policy"]);
    ok(liveProdCsp.get("frame-src") === "https://decks.example.test", `正式模式：frame-src 完全等於 https://decks.example.test（實際：${liveProdCsp.get("frame-src")}）`);
    ok(liveProdCsp.get("connect-src") === `'self' ws://127.0.0.1:${new URL(stack.prodBase).port}`, "正式模式（測試以 http 連線）：connect-src 為 'self'＋精確 ws origin（https 時為 wss）");
    const index = await reqL("/");
    ok(cspDirectives(index.headers["content-security-policy"]).get("frame-src") === "'self' https://accounts.google.com/gsi/", "其他頁面維持 public/_headers 的 frame-src（未放行簡報主機）");
    // 主站各頁：只有一個 CSP 標頭；connect-src 沒有 ws:／wss: 萬用字元（S4-A 驗收第 2 項）
    for (const [label, path] of [["講師頁", "/teacher.html"], ["加入頁", "/"], ["建場頁", "/create.html"], ["live 頁", "/live?code=ABCDEF"]]) {
      const r = await reqL(path);
      const raw = r.headers["content-security-policy"];
      const c = cspDirectives(raw);
      const tokens = String(c.get("connect-src") || "").split(/\s+/);
      const single = typeof raw === "string" && [...raw.matchAll(/(?:^|;\s*)default-src/g)].length === 1;
      const noWild = !tokens.includes("ws:") && !tokens.includes("wss:") && !tokens.some((t) => t.includes("*"));
      ok(r.status < 400 && single && noWild, `${label}（${path}）：一個 CSP 標頭、connect-src 沒有 ws:／wss: 萬用字元（${c.get("connect-src")}）`);
      if (path !== "/live?code=ABCDEF") ok(c.get("connect-src") === "'self' https://accounts.google.com/gsi/", `${label}：connect-src 完全等於 'self' https://accounts.google.com/gsi/`);
    }

    // ---- 7. 建場 API 與公開場次 API ----
    ok((await createRoom(M, null, { deckId: multi.id, version: multi.version })).status === 401, "未登入、沒有密語：指定簡報建場 → 401（先驗身分才查目錄）");
    const room = await createRoom(M, A, { deckId: multi.id, version: multi.version });
    ok(room.status === 200 && /^[A-Z0-9]{6}$/.test(room.data?.code || ""), "以 ready 的簡報（deckId＋version）建場成功");
    const info = await reqL(`/api/rooms/${room.data.code}`);
    const keys = Object.keys(info.data || {}).sort().join(",");
    ok(keys === "count,deck,deckBase,deckUrl,exists,expiresAt", `公開場次 API 欄位白名單（${keys}）`);
    ok(!/uploaded_by|uploadedBy|files_json|owner|keyHash|upload_id|admin@example/.test(info.text), "公開場次 API 不含 uploaded_by、files_json、擁有者、金鑰雜湊或信箱");
    ok(info.data?.deckBase === `${D}/${multi.uploadId}/` && info.data?.deckUrl === `${D}/${multi.uploadId}/index.html`, "簡報網址由 upload_id 組成（deckBase／deckUrl）");
    ok(info.data?.deck?.id === multi.id && info.data?.deck?.version === multi.version && info.data?.deck?.pages?.length === multi.deck.pages.length, "場次 deck 快照取自目錄（id、version、頁數相符）");
    const viaUrl = info.data?.deckUrl ? await req(D, new URL(info.data.deckUrl).pathname) : { status: 0 };
    const info127 = await req(M, `/api/rooms/${room.data.code}`);
    ok(info127.data?.exists === true && info127.data?.deckBase === null && info127.data?.deckUrl === null, "主站以 127.0.0.1 存取（與簡報主機同主機名）→ 不提供簡報網址（fail closed）");
    ok(viaUrl.status === 200, "場次 API 給的簡報網址可在簡報主機開啟");
    const sec = readFileSync(join(root, ".dev.vars"), "utf8").match(/^CREATE_SECRET=(.*)$/m)?.[1]?.trim();
    if (sec) {
      const bySecret = await createRoom(M, null, { secret: sec, deckId: sample.id, version: sample.version });
      const si = await reqL(`/api/rooms/${bySecret.data?.code}`);
      ok(bySecret.status === 200 && si.data?.deckBase === `${D}/${sample.uploadId}/`, "建場密語也可指定簡報（範例簡報）");
    }
    const builtin = await createRoom(M, A, {});
    const bi = await reqL(`/api/rooms/${builtin.data?.code}`);
    ok(builtin.status === 200 && bi.data?.deckBase === null && bi.data?.deckUrl === null && bi.data?.deck?.id === "ai-era-education", "未指定簡報：使用內建範例，沒有簡報網址（S3d-C 前的過渡）");
    const rej = [
      [{ deckId: disabled.id, version: disabled.version }, 404, "停用的簡報"],
      [{ deckId: revoked.id, version: revoked.version }, 404, "撤銷的簡報"],
      [{ deckId: pending.id, version: pending.version }, 404, "pending 的簡報"],
      [{ deckId: "no-such-deck", version: "v1" }, 404, "不存在的簡報"],
      [{ deckId: multi.id }, 400, "只有 deckId 沒有 version"],
      [{ version: multi.version }, 400, "只有 version 沒有 deckId"],
      [{ deckId: "../x", version: multi.version }, 400, "deckId 格式錯誤"],
      [{ deckId: multi.id, version: 5 }, 400, "version 不是字串"],
      [{ deckId: ["a"], version: multi.version }, 400, "deckId 是陣列"],
    ];
    for (const [body, status, label] of rej) {
      const r = await createRoom(M, A, body);
      ok(r.status === status && !r.data?.key, `用${label}建場 → ${status}（實際 ${r.status}）`);
    }

    // ---- 2. WebSocket：簡報主機 origin、沒有 Origin → 拒絕（帶管理者 cookie）----
    const wsStatus = (origin) => new Promise((resolve) => {
      const u = new URL(M);
      const headers = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"), cookie: A };
      if (origin !== undefined) headers.origin = origin;
      const r = http.request({ hostname: u.hostname, port: u.port, path: `/api/rooms/${room.data.code}/ws`, headers, timeout: 10000 });
      r.on("upgrade", (res, s) => { s.destroy(); resolve(res.statusCode); });
      r.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", () => resolve(0));
      r.end();
    });
    ok((await wsStatus(D)) === 403, `WebSocket：Origin 為簡報主機（${D}）＋講師 cookie → 403`);
    ok((await wsStatus(undefined)) === 403, "WebSocket：沒有 Origin＋講師 cookie → 403");
    ok((await wsStatus(new URL(M).origin)) === 101, "WebSocket：Origin 等於主站 → 101（對照）");
  } finally {
    stack.stop();
  }
  console.log(failed ? `\n${failed} 項失敗（${passed} 項通過）` : `\n全部通過（${passed} 項）`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log("FAIL  " + (e?.stack || e)); process.exit(1); });
}
