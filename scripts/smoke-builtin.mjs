// 內建簡報（方案 B）冒煙測試：以「不綁 R2」的正式部署設定（wrangler.production.toml）在本機啟動主站＋簡報主機，
// 驗證內建簡報可列出、建場、由簡報主機以完整安全標頭提供；清單外路徑、deck.json、資料夾直讀一律 404；上傳端點停用。
// 最後對同一組實例執行 scripts/prod-check.mjs --dev。
// 自己啟動 wrangler dev 並記錄 PID，測完只關自己的程序樹；不碰 8791／8801／8802 與其他測試埠。
//   主站 127.0.0.1:8841（以 localhost 開）、簡報主機 127.0.0.1:8842
// 用法：node scripts/smoke-builtin.mjs
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { req, sleep, root, ADMIN } from "./smoke-deckhost.mjs";
import { BUILTIN_DECKS } from "../src/builtin-decks.generated.js";

const MAIN_PORT = 8841, DECK_PORT = 8842;
const MAIN = `http://localhost:${MAIN_PORT}`, DECK = `http://127.0.0.1:${DECK_PORT}`;
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");
let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  ← " + detail}`); };
const portBusy = (port) => new Promise((resolve) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
const killTree = (p) => { if (p?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" }); };

const persist = ".wrangler/smoke-builtin";
const registry = join(root, ".wrangler", "registry-smoke-builtin");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_REGISTRY_PATH: registry };
function start(args) {
  const p = spawn(process.execPath, [wranglerJs, "dev", ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d)); p.log = () => log;
  return p;
}

const procs = [];
try {
  for (const p of [MAIN_PORT, DECK_PORT]) if (await portBusy(p)) throw new Error(`${p} 埠已被其他程序使用（不會關閉別人的程序）`);
  for (const d of [join(root, persist), registry]) rmSync(d, { recursive: true, force: true });
  procs.push(start(["-c", "wrangler.production.toml", "--ip", "127.0.0.1", "--port", String(MAIN_PORT), "--persist-to", persist,
    "--var", "ENVIRONMENT:development", "--var", "DEV_LOGIN:1", "--var", `ADMIN_EMAILS:${ADMIN}`, "--var", `DECK_ORIGIN:${DECK}`,
    "--var", "GOOGLE_CLIENT_ID:smoke-builtin.apps.googleusercontent.com"]));
  procs.push(start(["-c", "deck-host/wrangler.production.toml", "--ip", "127.0.0.1", "--port", String(DECK_PORT), "--persist-to", persist,
    "--var", "ENVIRONMENT:development", "--var", `MAIN_ORIGIN:${MAIN}`]));
  console.log(`PID：主站=${procs[0].pid} 簡報主機=${procs[1].pid}`);
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    await sleep(1000);
    const a = await req(MAIN, "/api/health");
    const b = await req(DECK, "/");
    up = a.data?.app === "ptt-teach" && b.status === 404 && /env\.CATALOG[^\n]*\[connected\]/.test(procs[1].log());
  }
  if (!up) throw new Error("實例未就緒：\n" + procs.map((p) => p.log().slice(-800)).join("\n----\n"));
  check("正式部署設定沒有綁 R2（兩個 Worker 的啟動資訊都沒有 DECKS）", !/env\.DECKS/.test(procs[0].log()) && !/env\.DECKS/.test(procs[1].log()));

  const login = await req(MAIN, "/api/dev/login", { method: "POST", headers: { "content-type": "application/json", origin: MAIN }, body: { email: ADMIN } });
  const cookie = String(login.headers["set-cookie"]?.[0] || "").split(";")[0];
  check("管理者登入（前置）", login.status === 200 && !!cookie, `${login.status}`);

  const d = BUILTIN_DECKS[0];
  const entry = JSON.parse(d.deckJson).entry;
  let r = await req(MAIN, "/api/decks", { headers: { cookie } });
  check("預設清單（管理者簡報庫表格）不含內建簡報", r.status === 200 && Array.isArray(r.data?.decks) && r.data.decks.length === 0, r.text.slice(0, 200));
  r = await req(MAIN, "/api/decks?include=builtin", { headers: { cookie } });
  const first = r.data?.decks?.[0];
  check("簡報清單第一筆是內建簡報", r.status === 200 && first?.id === d.id && first?.version === d.version && first?.builtin === true && first?.state === "ready", r.text.slice(0, 200));
  check("清單只列內建簡報（簡報庫是空的）", r.data?.decks?.length === BUILTIN_DECKS.length, `${r.data?.decks?.length}`);

  r = await req(MAIN, "/api/rooms", { method: "POST", headers: { "content-type": "application/json", cookie, origin: MAIN }, body: { deckId: d.id, version: d.version } });
  const code = r.data?.code;
  check("以內建簡報建場 200", r.status === 200 && /^[A-Z0-9]{6}$/.test(code || ""), `${r.status} ${r.text}`);
  r = await req(MAIN, `/api/rooms/${code}`);
  check("場次的簡報網址指向簡報主機＋內建代號", r.data?.deckBase === `${DECK}/${d.uploadId}/` && r.data?.deckUrl === `${DECK}/${d.uploadId}/${entry}`, r.text.slice(0, 200));
  check("場次快照是內建簡報", r.data?.deck?.id === d.id && r.data?.deck?.version === d.version);
  r = await req(MAIN, "/api/rooms", { method: "POST", headers: { "content-type": "application/json", cookie, origin: MAIN }, body: { deckId: d.id, version: "9999-99-99" } });
  check("不存在的版本 404", r.status === 404, `${r.status}`);

  r = await req(DECK, `/${d.uploadId}/${entry}`);
  const csp = r.headers["content-security-policy"] || "";
  const local = readFileSync(join(root, "builtin-decks", d.folder, entry));
  check("簡報主機提供入口 200，內容與來源一致", r.status === 200 && sha(r.raw) === sha(local), `${r.status}`);
  check("Content-Type 由副檔名決定", r.headers["content-type"] === "text/html; charset=utf-8", r.headers["content-type"]);
  check("CSP：sandbox allow-scripts＋frame-ancestors 只允許主站", csp.startsWith("sandbox allow-scripts") && csp.includes(`frame-ancestors ${MAIN}`), csp);
  check("nosniff、no-store、no-referrer、不設 cookie", r.headers["x-content-type-options"] === "nosniff" && r.headers["cache-control"] === "no-store" && r.headers["referrer-policy"] === "no-referrer" && !r.headers["set-cookie"]);
  r = await req(DECK, `/${d.uploadId}/${entry}`, { method: "HEAD" });
  check("HEAD 200、沒有本體、有 Content-Length", r.status === 200 && r.raw.length === 0 && Number(r.headers["content-length"]) === local.length, `${r.status} ${r.headers["content-length"]}`);
  const img = [...d.files.keys()].find((p) => /\.(jpg|png|webp|svg)$/.test(p));
  if (img) {
    r = await req(DECK, `/${d.uploadId}/${img}`);
    check(`清單內的圖檔 200 且雜湊一致（${img}）`, r.status === 200 && sha(r.raw) === d.files.get(img), `${r.status}`);
  }
  for (const [label, path] of [
    ["deck.json 不對外", `/${d.uploadId}/deck.json`],
    ["清單外的路徑", `/${d.uploadId}/nope.html`],
    ["以資料夾名稱直讀", `/${d.folder}/${entry}`],
    ["資料夾名稱＋deck.json", `/${d.folder}/deck.json`],
    ["大小寫不同的路徑", `/${d.uploadId}/${entry.toUpperCase()}`],
    ["百分比編碼路徑", `/${d.uploadId}/%69ndex.html`],
    ["上一層路徑", `/${d.uploadId}/../${d.folder}/${entry}`],
    ["未登記代號", `/${"0".repeat(32)}/${entry}`],
    ["根路徑", "/"],
  ]) {
    r = await req(DECK, path);
    check(`${label} 404`, r.status === 404 && (r.headers["content-security-policy"] || "").length > 0, `${r.status}`);
  }
  r = await req(DECK, `/${d.uploadId}/${entry}`, { method: "POST" });
  check("簡報主機拒絕 POST（405）", r.status === 405, `${r.status}`);

  r = await req(MAIN, "/api/admin/deck-uploads", { method: "POST", headers: { "content-type": "application/json", cookie, origin: MAIN }, body: { deck: "{}", files: [] } });
  check("上傳端點停用（503 uploads_disabled）", r.status === 503 && r.data?.code === "uploads_disabled", `${r.status} ${r.text}`);
  r = await req(MAIN, `/api/admin/decks/${d.id}/${d.version}/revoke`, { method: "POST", headers: { cookie, origin: MAIN } });
  check("簡報庫管理端點停用（503）", r.status === 503, `${r.status}`);

  // 對同一組實例跑線上檢查腳本（--dev）
  const pc = spawnSync(process.execPath, [join(root, "scripts", "prod-check.mjs"), "--main", MAIN, "--deck", DECK, "--dev"], { cwd: root, encoding: "utf8", timeout: 120000 });
  const last = (pc.stdout || "").trim().split("\n").at(-1);
  check("prod-check --dev 全部通過", pc.status === 0, `${last}\n${(pc.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join("\n")}${pc.stderr || ""}`);
} catch (e) {
  failed++;
  console.log("FAIL  執行錯誤：" + (e?.stack || e));
} finally {
  for (const p of procs) killTree(p);
}
console.log(`\nsmoke-builtin：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
