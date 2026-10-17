// 擷取簡報畫面文字，補進 deck.json 每頁的 text（S8 單頁 AI 問答的資料來源）。
// 做法：無頭 Chrome 以 file:// 開啟簡報 entry，對每個動畫段每 0.5 秒呼叫一次 window.seek(t)，
// 收集 #stage 內「實際看得到」（祖先 opacity 乘積 > 0.05）的 <text> 文字，依首次出現順序去重，再加上該段字幕。
// 只寫到 --out 指定的新資料夾（create-only，已存在就停止）；不改原簡報。
// 用法：node scripts/extract-deck-text.mjs <簡報資料夾> --out <新資料夾> --version <新版本號>
// 選用環境變數：CHROME（chrome.exe 路徑）、CDP_PORT（預設 9353）。只關自己啟動的 Chrome（taskkill /T）。
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const src = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
const out = opt("--out") ? resolve(opt("--out")) : null;
const version = opt("--version");
if (!src || !out || !version) { console.error("用法：node scripts/extract-deck-text.mjs <簡報資料夾> --out <新資料夾> --version <新版本號>"); process.exit(2); }
if (existsSync(out)) { console.error(`輸出資料夾已存在，不覆寫：${out}`); process.exit(2); }

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9353);
const PAGE_TEXT_MAX = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deck = JSON.parse(readFileSync(join(src, "deck.json"), "utf8"));
if (deck.runtime !== "timeline" || !Array.isArray(deck.segments)) { console.error("只支援 runtime=timeline 的簡報"); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), "deck-text-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--allow-file-access-from-files", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
const stop = () => { if (chrome.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" }); try { rmSync(profile, { recursive: true, force: true }); } catch {} };

let ws, nextId = 1;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("頁面執行錯誤：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// 頁面內：收集看得到的 <text>
const COLLECT = `(() => {
  const vis = (el) => { let o = 1; for (let e = el; e && e.id !== 'stage'; e = e.parentElement) {
    const a = e.getAttribute && e.getAttribute('opacity'); if (a !== null && a !== '') o *= Number(a);
    const cs = getComputedStyle(e); o *= Number(cs.opacity); if (cs.display === 'none' || cs.visibility === 'hidden') return 0; } return o; };
  return [...document.querySelectorAll('#stage text')].filter((t) => vis(t) > 0.05).map((t) => t.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean);
})()`;

try {
  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) { await sleep(250); try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
  if (!ver) throw new Error("Chrome 未就緒");
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  const url = pathToFileURL(join(src, deck.entry)).href;
  await cdp("Page.navigate", { url });
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { await sleep(250); ok = await evaluate("typeof window.seek === 'function' && Array.isArray(window.SEGS)").catch(() => false); }
  if (!ok) throw new Error("簡報沒有提供 window.seek／window.SEGS");
  await evaluate("window.ready || null");
  const segInfo = await evaluate("window.SEGS.map((s) => ({ a: s.a, b: s.b, cap: s.cap }))");

  const segText = [];
  for (let i = 0; i < segInfo.length; i++) {
    const { a, b, cap } = segInfo[i];
    const seen = [];
    for (let t = a + 0.05; t < b; t += 0.5) {
      await evaluate(`Promise.resolve(window.seek(${t.toFixed(2)}))`);
      for (const s of await evaluate(COLLECT)) if (!seen.includes(s)) seen.push(s);
    }
    await evaluate(`Promise.resolve(window.seek(${(b - 0.02).toFixed(2)}))`);
    for (const s of await evaluate(COLLECT)) if (!seen.includes(s)) seen.push(s);
    const capText = String(cap || "").replace(/<[^>]*>/g, "").trim();
    // 去掉打字機動畫的半截字（是另一行開頭片段者）與頁尾頁碼列
    const lines = seen.filter((s) => !/^\d+ \/ \d+\u30fb/.test(s) && !seen.some((o) => o !== s && o.startsWith(s)));
    segText.push({ lines, cap: capText });
  }

  const next = JSON.parse(JSON.stringify(deck));
  next.version = version;
  const report = [];
  next.pages.forEach((pg, idx) => {
    if (pg.type !== "anim") return;
    const s = segText[pg.seg];
    if (!s) return;
    const parts = [];
    if (s.cap) parts.push(`字幕：${s.cap}`);
    if (s.lines.length) parts.push(`畫面文字：\n${s.lines.join("\n")}`);
    let text = parts.join("\n");
    if ([...text].length > PAGE_TEXT_MAX) text = [...text].slice(0, PAGE_TEXT_MAX).join("");
    pg.text = text;
    report.push({ page: idx + 1, seg: pg.seg, chars: [...text].length, lines: s.lines.length });
  });

  cpSync(src, out, { recursive: true, errorOnExist: true, force: false });
  writeFileSync(join(out, "deck.json"), JSON.stringify(next, null, 2) + "\n", { flag: "w" });
  console.log(`已寫入 ${join(out, "deck.json")}（version ${version}）`);
  for (const r of report) console.log(`第 ${r.page} 頁（動畫段 ${r.seg}）：${r.lines} 行畫面文字，共 ${r.chars} 字`);
} catch (e) {
  console.error("擷取失敗：" + (e?.stack || e));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  stop();
}
