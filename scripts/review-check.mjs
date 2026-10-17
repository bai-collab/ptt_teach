// 審查用整合檢查：在 8811 埠啟動「獨立資料目錄」的 wrangler dev，跑 smoke-ws 與 smoke-auth，再跑 smoke-decks（自行啟動實例）與 deploy --dry-run。
// 只關閉自己啟動的程序（記錄 PID，taskkill /T），不碰使用者自己開的伺服器。
// 用法（repo 根目錄或專案目錄皆可）：node projects/ptt_teach/scripts/review-check.mjs
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (id, ok, detail = "") => { results.push({ id, ok }); console.log(`${ok ? "OK  " : "FAIL"} ${id}${detail ? "：" + detail : ""}`); };

if (!existsSync(wrangler)) { console.log("FAIL 找不到 wrangler：" + wrangler + "（請先在專案目錄執行 npm install）"); process.exit(1); }
const vars = existsSync(join(root, ".dev.vars")) ? readFileSync(join(root, ".dev.vars"), "utf8") : "";
const secret = (vars.match(/^CREATE_SECRET=(.*)$/m) || [])[1]?.trim();
const testAuth = /^GOOGLE_JWKS=/m.test(vars) && existsSync(join(root, ".wrangler", "test-google-key.json"));

const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const dev = spawn(process.execPath, [wrangler, "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--persist-to", ".wrangler/review-state"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d)); dev.stderr.on("data", (d) => (devLog += d));
const stopDev = () => { if (dev.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(dev.pid)], { stdio: "ignore" }); };

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(1000);
    try { up = (await (await fetch(`${BASE}/api/health`)).json()).app === "ptt-teach"; } catch {}
  }
  step("wrangler-dev-ready", up, up ? BASE : devLog.slice(-800));
  if (up) {
    const ws = spawnSync(process.execPath, [join(root, "scripts", "smoke-ws.mjs"), BASE], { env: { ...env, CREATE_SECRET: secret || "" }, encoding: "utf8" });
    const wsOut = ws.stdout || "";
    step("smoke-ws", ws.status === 0, `${(wsOut.match(/^PASS/gm) || []).length} PASS／${(wsOut.match(/^FAIL/gm) || []).length} FAIL`);
    if (ws.status !== 0) console.log(wsOut.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
    if (testAuth) {
      const au = spawnSync(process.execPath, [join(root, "scripts", "smoke-auth.mjs"), BASE], { env, encoding: "utf8" });
      const auOut = au.stdout || "";
      step("smoke-auth", au.status === 0, `${(auOut.match(/^PASS/gm) || []).length} PASS／${(auOut.match(/^FAIL/gm) || []).length} FAIL`);
      if (au.status !== 0) console.log(auOut.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
    } else step("smoke-auth", false, ".dev.vars 未含測試用 GOOGLE_JWKS（先執行 npm run test-auth）");
  }
} finally { stopDev(); }

// 簡報庫（S3c-1）：smoke-decks 自己啟動 8821／8822／8824 的 wrangler dev 實例（獨立資料目錄），測完只關自己的程序樹
const decks = spawnSync(process.execPath, [join(root, "scripts", "smoke-decks.mjs")], { cwd: root, env, encoding: "utf8", timeout: 540000 });
const decksOut = decks.stdout || "";
step("smoke-decks", decks.status === 0, `${(decksOut.match(/^PASS/gm) || []).length} PASS／${(decksOut.match(/^FAIL/gm) || []).length} FAIL`);
if (decks.status !== 0) console.log(decksOut.split("\n").filter((l) => l.startsWith("FAIL")).join("\n") || (decks.stderr || "").slice(-800));

const dry = spawnSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", ".wrangler/dry-run"], { cwd: root, env, encoding: "utf8" });
step("deploy-dry-run", dry.status === 0 && /dry-run: exiting now/.test(dry.stdout + dry.stderr));

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 項未通過` : "\n全部通過");
process.exit(bad.length ? 1 : 0);
