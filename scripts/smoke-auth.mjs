// 本機冒煙測試：Google 登入（以 make-test-auth.mjs 的測試金鑰簽發 ID token）、講師名單、我的場次、備援連結、登入講師直接取得講師身分。
// 另驗證本機開發後門只在「ENVIRONMENT=development＋迴環主機名」生效：非迴環 Host 與 ENVIRONMENT=production（另啟 8812 埠）時，
// /api/dev/login 回 404、登入設定回報 devLogin=false、測試公鑰簽的憑證被拒。
// 用法：node scripts/make-test-auth.mjs → 重啟 wrangler dev → node scripts/smoke-auth.mjs [base]
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] || "http://127.0.0.1:8801";
const ORIGIN = new URL(base).origin; // WebSocket 升級必須帶 Origin＝主站 origin（S3d-B）
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { kid, privateKeyPem } = JSON.parse(readFileSync(join(root, ".wrangler", "test-google-key.json"), "utf8"));
const CLIENT = "local-test-client.apps.googleusercontent.com";

let failed = 0;
const ok = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) failed++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function idToken(claims, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: CLIENT, iat: now, exp: now + 600, email_verified: true, ...claims };
  const head = b64({ alg: "RS256", kid: opts.kid || kid, typ: "JWT" });
  const body = b64(payload);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem).toString("base64url");
  return `${head}.${body}.${opts.badSig ? sig.slice(0, -4) + "AAAA" : sig}`;
}
async function call(path, { method = "GET", body, cookie, origin } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch {}
  const set = r.headers.get("set-cookie");
  return { status: r.status, data, cookie: set ? set.split(";")[0] : null };
}
const login = (email, extra = {}, opts) => call("/api/auth/google", { method: "POST", body: { credential: idToken({ email, name: email.split("@")[0], ...extra }, opts) } });

const cfg = await call("/api/auth/config");
ok(cfg.data.googleClientId === CLIENT, "登入設定回傳 Google 用戶端 ID");

// 憑證驗證
ok((await login("admin@example.test", {}, { badSig: true })).status === 401, "竄改簽章的憑證被拒");
ok((await login("admin@example.test", { aud: "other-app" })).status === 401, "發給其他應用程式的憑證被拒");
ok((await login("admin@example.test", { exp: Math.floor(Date.now() / 1000) - 10 })).status === 401, "過期憑證被拒");
ok((await login("admin@example.test", { email_verified: false })).status === 401, "信箱未驗證的帳號被拒");
ok((await login("admin@example.test", { iss: "https://evil.example" })).status === 401, "發行者不是 Google 的憑證被拒");
const outsider = await login("stranger@example.test");
ok(outsider.status === 403 && /不在講師名單/.test(outsider.data.error), "不在名單的 Google 帳號不能登入");

// 管理者
const admin = await login("Admin@Example.test");
ok(admin.status === 200 && admin.data.isAdmin && admin.cookie, "管理者登入成功（信箱不分大小寫）");
const A = admin.cookie;
ok((await call("/api/me", { cookie: A })).data.email === "admin@example.test", "登入後 /api/me 取得身分");
ok((await call("/api/me", { cookie: A.slice(0, -3) + "xyz" })).status === 401, "竄改的登入 cookie 無效");
ok((await call("/api/admin/presenters", { method: "POST", cookie: A, body: { email: "t1@example.test" }, origin: "https://evil.example" })).status === 403, "跨站來源的請求被拒");
const add = await call("/api/admin/presenters", { method: "POST", cookie: A, body: { email: "T1@example.test" } });
ok(add.status === 200 && add.data.presenters.some((p) => p.email === "t1@example.test"), "管理者把講師加入名單");
ok((await call("/api/admin/presenters", { method: "POST", cookie: A, body: { email: "not-an-email" } })).status === 400, "錯誤信箱格式被拒");

// 講師
const t1 = await login("t1@example.test");
ok(t1.status === 200 && !t1.data.isAdmin, "名單上的講師可以登入");
const T = t1.cookie;
ok((await call("/api/admin/presenters", { cookie: T })).status === 403, "一般講師不能管理名單");
const room = await call("/api/rooms", { method: "POST", cookie: T, body: {} });
ok(room.status === 200 && /^[A-Z0-9]{6}$/.test(room.data.code), "登入講師不需密語即可建場");
ok((await call("/api/rooms", { method: "POST", body: {} })).status === 401, "未登入且沒有密語不能建場");
const mine = await call("/api/my/rooms", { cookie: T });
ok(mine.data.rooms?.some((r) => r.code === room.data.code), "「我的場次」列出剛建立的場次");
ok(!(await call("/api/my/rooms", { cookie: A })).data.rooms.some((r) => r.code === room.data.code), "別人的場次不會出現在自己的清單");

// 備援講師連結
const link = await call(`/api/rooms/${room.data.code}/link`, { method: "POST", cookie: T, body: {} });
ok(link.status === 200 && link.data.key, "場次擁有者可以產生備援講師連結");
await call("/api/admin/presenters", { method: "POST", cookie: A, body: { email: "t2@example.test" } });
const T2 = (await login("t2@example.test")).cookie;
ok((await call(`/api/rooms/${room.data.code}/link`, { method: "POST", cookie: T2, body: {} })).status === 403, "其他講師不能產生別人場次的講師連結");
ok((await call(`/api/rooms/${room.data.code}/link`, { method: "POST", cookie: A, body: {} })).status === 200, "管理者可以產生任何場次的講師連結");

// WebSocket 身分
function ws(cookie, hello) {
  return new Promise((resolve) => {
    const s = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${room.data.code}/ws`, { headers: cookie ? { cookie, origin: ORIGIN } : { origin: ORIGIN } });
    const inbox = [];
    s.addEventListener("message", (e) => { const m = JSON.parse(e.data); inbox.push(m); if (m.type === "init") resolve({ s, init: m, inbox }); });
    s.addEventListener("open", () => s.send(JSON.stringify({ type: "hello", ...hello })));
    setTimeout(() => resolve({ s, init: null, inbox }), 4000);
  });
}
const owner = await ws(T, { pid: "owner-pid-0001", name: "講師一" });
ok(owner.init?.me.role === "presenter", "登入的場次擁有者直接取得講師身分（不需金鑰）");
const other = await ws(T2, { pid: "other-pid-0001", name: "講師二" });
ok(other.init?.me.role === "participant", "其他登入講師進別人的場次是一般身分");
const backup = await ws(null, { pid: "helper-pid-001", name: "助教", key: link.data.key });
ok(backup.init?.me.role === "presenter", "備援講師連結可以取得講師身分");
const spoof = await new Promise((resolve) => {
  const s = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${room.data.code}/ws`, { headers: { "X-AEE-Email": "t1@example.test", origin: ORIGIN } });
  s.addEventListener("open", () => s.send(JSON.stringify({ type: "hello", pid: "spoof-pid-0001", name: "冒充" })));
  s.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.type === "init") { resolve(m.me.role); s.close(); } });
  setTimeout(() => resolve(null), 4000);
});
ok(spoof === "participant", "偽造 X-AEE-Email 標頭無法冒充講師");
// 惡意簡報頁冒用講師 cookie 開 WebSocket（S3d-B）：帶講師 cookie 但 Origin 是簡報主機或 "null" → 連不上
for (const badOrigin of ["http://127.0.0.1:8802", "null"]) {
  const r = await new Promise((resolve) => {
    const s = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${room.data.code}/ws`, { headers: { cookie: T, origin: badOrigin } });
    s.addEventListener("open", () => { s.close(); resolve("open"); });
    s.addEventListener("error", () => resolve("error"));
    setTimeout(() => resolve("timeout"), 4000);
  });
  ok(r === "error", `帶講師 cookie、Origin 為 ${badOrigin} 的 WebSocket 被拒`);
}

// 結束場次後從擁有者的「我的場次」消失
owner.s.close(); other.s.close();
backup.s.send(JSON.stringify({ type: "room.end" }));
await new Promise((r) => setTimeout(r, 500));
ok(!(await call("/api/my/rooms", { cookie: T })).data.rooms?.some((r) => r.code === room.data.code), "結束後的場次不再列在擁有者的清單");
backup.s.close();

// 移除講師後登入立即失效
await call(`/api/admin/presenters?email=${encodeURIComponent("t1@example.test")}`, { method: "DELETE", cookie: A });
ok((await call("/api/me", { cookie: T })).status === 401, "移出名單後，原本的登入立即失效");

// 登出：伺服器清除 cookie
const out = await call("/api/auth/logout", { method: "POST", cookie: A });
ok(out.status === 200 && out.cookie === "aee_s=", "登出時清除登入 cookie");

// ---- 開發後門只限迴環主機 ----
// 用 node:http 送請求才能自訂 Host 標頭（fetch 會忽略自訂 Host）；wrangler dev 以 Host 標頭組出 Worker 看到的 request.url。
function rawCall(baseUrl, path, { method = "GET", body, host } = {}) {
  const u = new URL(baseUrl);
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = { "content-type": "application/json" };
    if (host) headers.host = host;
    if (payload) headers["content-length"] = Buffer.byteLength(payload);
    const req = http.request({ hostname: u.hostname, port: u.port, path, method, headers, timeout: 20000 }, (r) => {
      let b = ""; r.setEncoding("utf8"); r.on("data", (d) => (b += d));
      r.on("end", () => {
        let data = {}; try { data = JSON.parse(b); } catch {}
        const set = r.headers["set-cookie"];
        resolve({ status: r.statusCode, data, cookie: set ? String(set[0]).split(";")[0] : null });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, data: { error: e.message }, cookie: null }));
    if (payload) req.write(payload);
    req.end();
  });
}
const adminCredential = () => idToken({ email: "admin@example.test", name: "admin" });
const NON_LOOPBACK = ["example.com", "localhost.example.com"];

// 對照組：同一個開發實例、迴環主機名時後門可用（證明下面的 404／401 是主機名條件造成的）
ok((await rawCall(base, "/api/auth/config")).data.devLogin === true, "對照：開發模式＋迴環主機名時 devLogin=true");
const devOk = await rawCall(base, "/api/dev/login", { method: "POST", body: { email: "admin@example.test" } });
ok(devOk.status === 200 && !!devOk.cookie, "對照：開發模式＋迴環主機名時 /api/dev/login 可登入");
const gOk = await rawCall(base, "/api/auth/google", { method: "POST", body: { credential: adminCredential() } });
ok(gOk.status === 200 && !!gOk.cookie, "對照：開發模式＋迴環主機名時採用測試公鑰");
for (const host of NON_LOOPBACK) {
  ok((await rawCall(base, "/api/auth/config", { host })).data.devLogin === false, `非迴環主機名（${host}）時 devLogin=false`);
  const d = await rawCall(base, "/api/dev/login", { method: "POST", body: { email: "admin@example.test" }, host });
  ok(d.status === 404 && !d.cookie, `非迴環主機名（${host}）時 /api/dev/login 回 404`);
  const g = await rawCall(base, "/api/auth/google", { method: "POST", body: { credential: adminCredential() }, host });
  ok(g.status === 401 && !g.cookie, `非迴環主機名（${host}）時不採用測試公鑰（測試金鑰簽的憑證被拒）`);
}

// ENVIRONMENT=production：另啟 8812 埠的 wrangler dev（--var 覆寫 ENVIRONMENT、獨立資料目錄），只關閉自己啟動的 PID 樹
const PROD_PORT = 8812;
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if ((await rawCall(PROD_BASE, "/api/health")).status !== 0) {
  ok(false, `${PROD_PORT} 埠已被其他程序使用，無法驗證 ENVIRONMENT=production（不會關閉別人的程序）`);
} else {
  const prod = spawn(process.execPath, [wranglerJs, "dev", "--ip", "127.0.0.1", "--port", String(PROD_PORT), "--persist-to", ".wrangler/smoke-prod-state", "--var", "ENVIRONMENT:production"],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let prodLog = "";
  prod.stdout.on("data", (d) => (prodLog += d)); prod.stderr.on("data", (d) => (prodLog += d));
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(1000); up = (await rawCall(PROD_BASE, "/api/health")).data.app === "ptt-teach"; }
    ok(up, `ENVIRONMENT=production 實例在 ${PROD_PORT} 埠啟動（PID ${prod.pid}）`);
    if (!up) console.log(prodLog.slice(-800));
    else {
      const c = (await rawCall(PROD_BASE, "/api/auth/config")).data;
      ok(c.devLogin === false && c.googleClientId === CLIENT, "ENVIRONMENT=production（同一份 .dev.vars、迴環主機名）時 devLogin=false");
      const d = await rawCall(PROD_BASE, "/api/dev/login", { method: "POST", body: { email: "admin@example.test" } });
      ok(d.status === 404 && !d.cookie, "ENVIRONMENT=production 時 /api/dev/login 回 404");
      const g = await rawCall(PROD_BASE, "/api/auth/google", { method: "POST", body: { credential: adminCredential() } });
      ok(g.status === 401 && !g.cookie, "ENVIRONMENT=production 時不採用測試公鑰（測試金鑰簽的憑證被拒）");
    }
  } finally {
    if (prod.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(prod.pid)], { stdio: "ignore" });
  }
}

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
