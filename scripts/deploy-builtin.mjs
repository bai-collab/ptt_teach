// 重新部署 ptt_teach（方案 B：內建簡報，不使用 R2）。
// 步驟：產生內建簡報清單 → 確認工作樹乾淨（產出已 commit）→ 本機測試 → wrangler 登入檢查 → 部署主站 → 部署簡報主機 → 線上檢查。
// 用法：
//   node scripts/deploy-builtin.mjs --plan                         只檢查與列出要做的事，不部署（預設）
//   node scripts/deploy-builtin.mjs --deploy                       實際部署（之後依 keep_vars 保留後台變數）
//   node scripts/deploy-builtin.mjs --deploy --first-time --admin <管理者信箱> --google-client-id <ID>
//                                                                  第一次部署：一併以 --var 設定 ADMIN_EMAILS、GOOGLE_CLIENT_ID、DECK_ORIGIN、MAIN_ORIGIN
// 選項：--subdomain <workers.dev 子網域>（必填）、--skip-tests（只在已於同一 commit 跑過測試時使用）
// 安全：不讀取、不輸出任何金鑰；不 push、不改 Cloudflare 以外的東西；任何步驟失敗立即停止。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DEPLOY = has("--deploy");
const FIRST = has("--first-time");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
const stepLog = [];

function run(label, cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", timeout: 30 * 60 * 1000 });
  const ok = r.status === 0;
  stepLog.push(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok && !allowFail) {
    if (capture) process.stdout.write((r.stdout || "") + (r.stderr || ""));
    console.error(`\n停止：「${label}」失敗（結束碼 ${r.status}）`);
    summary(1);
  }
  return r;
}
const node = (label, script, extra = [], o) => run(label, process.execPath, [join(root, script), ...extra], o);
function summary(code) {
  console.log("\n==== 摘要 ====");
  for (const l of stepLog) console.log(l);
  process.exit(code);
}

// 1. 產生並確認產出一致
node("產生內建簡報清單與正式部署設定", "scripts/build-builtin-decks.mjs");
node("確認產出與來源一致", "scripts/build-builtin-decks.mjs", ["--check"]);

// 2. 工作樹必須乾淨（部署的內容要能對應到一個 commit）
const st = run("檢查 git 工作樹", "git", ["status", "--porcelain"], { capture: true });
const dirty = (st.stdout || "").trim();
if (dirty) {
  console.error("工作樹有未提交的改動，請先 commit 再部署：\n" + dirty);
  stepLog.push("FAIL 工作樹必須乾淨");
  summary(1);
}
const head = run("讀取 HEAD", "git", ["rev-parse", "--short", "HEAD"], { capture: true }).stdout.trim();
console.log(`部署來源 commit：${head}`);

// 3. 本機測試
if (!has("--skip-tests")) {
  run("單元測試（node --test）", process.execPath, ["--test", "test/*.test.mjs"], { capture: true });
  node("smoke-builtin（正式設定、不綁 R2）", "scripts/smoke-builtin.mjs");
  node("smoke-ask（單頁 AI 問答）", "scripts/smoke-ask.mjs");
} else {
  stepLog.push("SKIP 本機測試（--skip-tests）");
}

// 4. wrangler 登入與子網域
const who = run("wrangler 登入檢查", process.execPath, [wrangler, "whoami"], { capture: true });
const acct = /Account ID[\s\S]*?([0-9a-f]{32})/.exec(who.stdout || "")?.[1];
if (!acct) { console.error("無法從 wrangler whoami 取得帳號（請先在本機執行 wrangler login）"); summary(1); }
const sub = opt("--subdomain");
if (!sub || !/^[a-z0-9-]{1,63}$/.test(sub)) { console.error("請加 --subdomain <workers.dev 子網域>（例如 Cloudflare 後台 Workers 概覽顯示的 xxx.workers.dev 的 xxx）"); summary(1); }
const MAIN = `https://ptt-teach.${sub}.workers.dev`;
const DECK = `https://ptt-teach-deck-host.${sub}.workers.dev`;
console.log(`主站：${MAIN}\n簡報主機：${DECK}`);

const mainVars = [];
const deckVars = [];
if (FIRST) {
  const admin = opt("--admin"), gid = opt("--google-client-id");
  if (!admin || !/^[^@\s,]+@[^@\s,]+$/.test(admin)) { console.error("--first-time 需要 --admin <管理者信箱>"); summary(1); }
  if (!gid || !/^[A-Za-z0-9.-]+\.apps\.googleusercontent\.com$/.test(gid)) { console.error("--first-time 需要 --google-client-id <…apps.googleusercontent.com>"); summary(1); }
  mainVars.push("--var", `ADMIN_EMAILS:${admin}`, "--var", `GOOGLE_CLIENT_ID:${gid}`, "--var", `DECK_ORIGIN:${DECK}`);
  deckVars.push("--var", `MAIN_ORIGIN:${MAIN}`);
}

if (!DEPLOY) {
  console.log("\n（--plan）將執行：");
  console.log(`  wrangler deploy -c wrangler.production.toml ${mainVars.filter((v) => v !== "--var").map((v) => "--var " + v.split(":")[0] + ":…").join(" ")}`);
  console.log(`  wrangler deploy -c deck-host/wrangler.production.toml ${deckVars.filter((v) => v !== "--var").map((v) => "--var " + v.split(":")[0] + ":…").join(" ")}`);
  console.log(`  node scripts/prod-check.mjs --main ${MAIN} --deck ${DECK}`);
  console.log("加上 --deploy 才會實際部署。");
  summary(0);
}

// 5. 部署：先主站（簡報主機綁定主站的 Catalog DO），再簡報主機
run("部署主站（ptt-teach）", process.execPath, [wrangler, "deploy", "-c", "wrangler.production.toml", ...mainVars]);
run("部署簡報主機（ptt-teach-deck-host）", process.execPath, [wrangler, "deploy", "-c", "deck-host/wrangler.production.toml", ...deckVars]);

// 6. 線上檢查（部署剛完成時可能需要幾秒生效，失敗重試一次）
let pc = node("線上檢查", "scripts/prod-check.mjs", ["--main", MAIN, "--deck", DECK], { allowFail: true });
if (pc.status !== 0) {
  stepLog.pop();
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},15000)"]);
  pc = node("線上檢查（15 秒後重試）", "scripts/prod-check.mjs", ["--main", MAIN, "--deck", DECK]);
}
console.log(`\n完成：commit ${head} 已部署。講師入口 ${MAIN}/teacher.html`);
summary(0);
