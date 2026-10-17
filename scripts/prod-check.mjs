// 線上（正式部署）唯讀檢查：部署後確認主站與簡報主機的安全設定與內建簡報是否生效。
// 只送 GET／HEAD 與不會改變狀態的請求（未登入的 POST 預期被拒）；不登入、不建場、不帶任何金鑰。
// 用法：node scripts/prod-check.mjs --main https://<主站> --deck https://<簡報主機>
// 也可用於本機（--main http://localhost:8841 --deck http://127.0.0.1:8842 --dev）：--dev 只放寬 https 與 devLogin 的檢查。
import { BUILTIN_DECKS } from "../src/builtin-decks.generated.js";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const MAIN = (opt("--main") || "").replace(/\/+$/, "");
const DECK = (opt("--deck") || "").replace(/\/+$/, "");
const DEV = args.includes("--dev");
if (!MAIN || !DECK) { console.error("用法：node scripts/prod-check.mjs --main https://<主站> --deck https://<簡報主機>"); process.exit(2); }

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { ok ? passed++ : failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  ← " + detail}`); };
const get = async (url, init = {}) => {
  try {
    const r = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(20000) });
    const text = init.method === "HEAD" ? "" : await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, data };
  } catch (e) { return { status: 0, headers: new Headers(), text: String(e), data: null }; }
};

if (!DEV) {
  check("主站使用 https", MAIN.startsWith("https://"));
  check("簡報主機使用 https", DECK.startsWith("https://"));
}
check("主站與簡報主機主機名不同", new URL(MAIN).hostname !== new URL(DECK).hostname);

// ---- 主站 ----
let r = await get(`${MAIN}/api/health`);
check("主站 /api/health", r.status === 200 && r.data?.app === "ptt-teach", `${r.status} ${r.text.slice(0, 120)}`);
r = await get(`${MAIN}/api/auth/config`);
if (!DEV) check("正式環境沒有開啟本機測試登入", r.status === 200 && r.data?.devLogin === false, r.text.slice(0, 160));
check("已設定 Google 用戶端 ID", typeof r.data?.googleClientId === "string" && r.data.googleClientId.endsWith(".apps.googleusercontent.com"), r.text.slice(0, 160));
if (!DEV) {
  r = await get(`${MAIN}/api/dev/login`, { method: "POST", headers: { "content-type": "application/json", origin: MAIN }, body: "{}" });
  check("/api/dev/login 為 404", r.status === 404, `${r.status}`);
}
r = await get(`${MAIN}/api/decks`);
check("未登入看不到簡報清單（401）", r.status === 401, `${r.status}`);
r = await get(`${MAIN}/api/admin/ai`);
check("未登入看不到 AI 設定（403）", r.status === 403, `${r.status}`);
r = await get(`${MAIN}/api/rooms`, { method: "POST", headers: { "content-type": "application/json", origin: MAIN }, body: "{}" });
check("未登入不能建場（401）", r.status === 401, `${r.status}`);
r = await get(`${MAIN}/api/rooms/ZZZZZZ`);
check("查詢不存在的場次回 exists:false", r.status === 200 && r.data?.exists === false, `${r.status}`);
r = await get(`${MAIN}/api/rooms/ZZZZZZ/ask`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
check("問 AI 跨來源被拒（403）", r.status === 403, `${r.status}`);
r = await get(`${MAIN}/live.html?code=ZZZZZZ`);
const liveCsp = r.headers.get("content-security-policy") || "";
check("live 頁 CSP 的 frame-src 含簡報主機", liveCsp.includes(`frame-src 'self' ${DECK}`) || new RegExp(`frame-src[^;]*${DECK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(liveCsp), liveCsp.slice(0, 200));
r = await get(`${MAIN}/teacher.html`);
check("講師頁可開啟", r.status === 200 || r.status === 307 || r.status === 308, `${r.status}`);

// ---- 簡報主機 ----
check("至少有一份內建簡報", BUILTIN_DECKS.length > 0);
for (const d of BUILTIN_DECKS) {
  const entry = JSON.parse(d.deckJson).entry;
  r = await get(`${DECK}/${d.uploadId}/${entry}`);
  const csp = r.headers.get("content-security-policy") || "";
  check(`內建簡報 ${d.id}@${d.version} 入口 200`, r.status === 200 && r.text.length > 0, `${r.status}`);
  check(`  CSP 為 sandbox allow-scripts`, csp.startsWith("sandbox allow-scripts"), csp.slice(0, 80));
  check(`  frame-ancestors 只允許主站`, csp.includes(`frame-ancestors ${MAIN}`), csp.slice(-120));
  check(`  nosniff 與 no-store`, r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("cache-control") === "no-store");
  check(`  不設 cookie`, !r.headers.get("set-cookie"));
  r = await get(`${DECK}/${d.uploadId}/deck.json`);
  check(`  deck.json 不對外（404）`, r.status === 404, `${r.status}`);
  r = await get(`${DECK}/${d.uploadId}/not-in-list.html`);
  check(`  清單外的路徑 404`, r.status === 404, `${r.status}`);
  r = await get(`${DECK}/${d.folder}/${entry}`);
  check(`  以資料夾名稱直接讀取 404（靜態檔不直接對外）`, r.status === 404, `${r.status}`);
}
r = await get(`${DECK}/${"0".repeat(32)}/index.html`);
check("未登記代號 404", r.status === 404, `${r.status}`);
r = await get(`${DECK}/`);
check("簡報主機根路徑 404", r.status === 404, `${r.status}`);
r = await get(`${DECK}/x/index.html`, { method: "POST" });
check("簡報主機拒絕 POST（405）", r.status === 405, `${r.status}`);

console.log(`\nprod-check：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
