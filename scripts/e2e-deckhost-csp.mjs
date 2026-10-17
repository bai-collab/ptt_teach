// 簡報主機 CSP（S4-A）CDP 測試：在真實 Chrome 中確認新 CSP 下合格簡報功能完整、沒有 CSP 違規，且簡報主機頁不能被其他 origin 嵌入。
// - 自行啟動主站（127.0.0.1:8861，瀏覽器以 http://localhost:8861 開）與簡報主機（127.0.0.1:8862，
//   --var ENVIRONMENT:development --var MAIN_ORIGIN:http://localhost:8861），以及嵌入測試頁伺服器（127.0.0.1:8863）。
//   以真實三步 API 上傳三份簡報（examples/decks/ai-era-education、examples/decks/multi-file-test、test/fixtures/legit-decks/full-features）後建場。
// - Chrome：headless、獨立使用者資料夾、除錯埠 9403；--host-resolver-rules 讓 localhost／127.0.0.1 以外的主機名一律解析失敗，
//   另加 --disable-background-networking、--disable-component-update，不對真實外部服務發出 DNS 或 HTTP 請求。
//   Google Fonts 以 Network.setBlockedURLs 攔截，並斷言其 blockedReason 是 inspector（不是 csp）。
//   --autoplay-policy=no-user-gesture-required 只為了讓 headless 能驗證「媒體可播放」，與 CSP、sandbox 無關。
// - 證據以瀏覽器端為主：Audits 的 ContentSecurityPolicyIssue、Network.loadingFailed.blockedReason、主控台的 CSP 訊息；
//   頁內 securitypolicyviolation 只當輔助。
// - 只關自己啟動的程序樹（wrangler 兩個、Chrome）與自己開的嵌入測試頁伺服器；不碰 8791／8801。
// 用法：node scripts/e2e-deckhost-csp.mjs（環境變數 CHROME 可指定 chrome.exe 路徑）
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, adminLogin, uploadDeckDir, createRoom, req, sleep, root, cspDirectives, expectedDeckCsp } from "./smoke-deckhost.mjs";

const MAIN_PORT = 8861, DECK_PORT = 8862, EMBED_PORT = 8863, CDP_PORT = 9403;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOTS = join(root, ".wrangler", "e2e-deckhost-csp-shots");
mkdirSync(SHOTS, { recursive: true });

let failed = 0, passed = 0;
const ok = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (c) passed++; else failed++; };
const info = (l) => console.log(`INFO  ${l}`);
const portBusy = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("connect", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

// 在 iframe 文件的任何腳本之前執行：記錄收到的訊息，以及頁內的 securitypolicyviolation（輔助證據）
const INSTRUMENT = `(() => {
  window.__pttGot = [];
  window.__cspv = [];
  addEventListener('securitypolicyviolation', (e) => window.__cspv.push(e.effectiveDirective + ' ' + e.blockedURI), true);
  addEventListener('message', (e) => {
    let rec;
    try { rec = { fromParent: e.source === window.parent, data: JSON.parse(JSON.stringify(e.data)) }; } catch { rec = { fromParent: e.source === window.parent, data: null }; }
    window.__pttGot.push(rec);
  }, true);
})();`;

// 瀏覽器端證據（所有 session 共用）；phase 標記目前階段
let phase = "init";
const evidence = { cspIssues: [], blocked: [], consoleCsp: [], unknownDirective: [], exceptions: [] };

async function run() {
  for (const p of [EMBED_PORT, CDP_PORT]) if (await portBusy(p)) throw new Error(`${p} 埠已被其他程序使用（不會關閉別人的程序）`);
  const stack = await startStack({ tag: "e2e-deckhost-csp", mainPort: MAIN_PORT, deckPort: DECK_PORT });
  console.log(`實例：主站 ${stack.mainBase}（PID ${stack.pids[0]}）、簡報主機 ${stack.deckBase}（PID ${stack.pids[1]}，MAIN_ORIGIN=${stack.mainOrigin}）`);
  const profile = mkdtempSync(join(tmpdir(), "ptt-dhcsp-"));
  let chrome = null, embedSrv = null;
  try {
    const M = stack.mainBase, D = stack.deckBase, L = stack.mainLocal;
    const A = await adminLogin(M);
    const decks = [
      { name: "範例動畫簡報", dir: join(root, "examples", "decks", "ai-era-education") },
      { name: "多檔測試簡報", dir: join(root, "examples", "decks", "multi-file-test") },
      { name: "合格功能樣本", dir: join(root, "test", "fixtures", "legit-decks", "full-features") },
    ];
    for (const d of decks) {
      d.up = await uploadDeckDir(M, A, d.dir);
      d.room = (await createRoom(M, A, { deckId: d.up.id, version: d.up.version })).data;
      d.base = `${D}/${d.up.uploadId}/`;
    }
    ok(decks.every((d) => d.room?.code && d.room?.key), `三份簡報經真實三步 API 上傳並建場（${decks.map((d) => d.room?.code).join("、")}）`);
    const entryHdr = await req(D, `/${decks[2].up.uploadId}/index.html`);
    ok(entryHdr.headers["content-security-policy"] === expectedDeckCsp(D, stack.mainOrigin), "合格功能樣本的 entry 帶契約 §4 的完整 CSP（frame-ancestors 為主站 origin）");

    // ---- 嵌入測試頁伺服器（127.0.0.1:8863；localhost:8863 也連到這裡）----
    embedSrv = http.createServer((q, s) => {
      const u = new URL(q.url, "http://x");
      if (u.pathname !== "/embed") { s.writeHead(404); return s.end(); }
      const target = u.searchParams.get("u") || "";
      if (!target.startsWith(D + "/")) { s.writeHead(400); return s.end(); }
      const esc = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      s.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      s.end(`<!doctype html><meta charset=utf-8><title>embed test</title>
<iframe id="sb" name="sb" sandbox="allow-scripts" src="${esc}"></iframe>
<iframe id="plain" name="plain" src="${esc}"></iframe>`);
    });
    await new Promise((r) => embedSrv.listen(EMBED_PORT, "127.0.0.1", r));

    // ---- Chrome ----
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "--disable-background-networking", "--disable-component-update",
      "--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    let ver;
    for (let i = 0; i < 60 && !ver; i++) { await sleep(250); try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {} }
    if (!ver) throw new Error("Chrome 未啟動");
    console.log(`Chrome：${ver.Browser}（PID ${chrome.pid}，除錯埠 ${CDP_PORT}）`);
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener("open", r));
    let seq = 0;
    const waiters = new Map();
    const listeners = [];
    const sessionLabel = new Map();
    bws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
      const where = `${phase}｜${sessionLabel.get(m.sessionId) || m.sessionId || "browser"}`;
      if (m.method === "Audits.issueAdded" && m.params.issue.code === "ContentSecurityPolicyIssue") {
        const d = m.params.issue.details.contentSecurityPolicyIssueDetails || {};
        evidence.cspIssues.push({ where, directive: d.violatedDirective, url: d.blockedURL || "", type: d.contentSecurityPolicyViolationType });
      }
      if (m.method === "Network.loadingFailed" && m.params.blockedReason) evidence.blocked.push({ where, reason: m.params.blockedReason, requestId: m.params.requestId, url: m.__url });
      if (m.method === "Log.entryAdded" || m.method === "Runtime.consoleAPICalled") {
        const text = m.params.entry?.text || (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (/Unrecognized Content-Security-Policy directive|unrecognized.*directive/i.test(text)) evidence.unknownDirective.push({ where, text });
        else if (/Content Security Policy|Content-Security-Policy|frame-ancestors/i.test(text)) evidence.consoleCsp.push({ where, text });
      }
      if (m.method === "Runtime.exceptionThrown") evidence.exceptions.push({ where, text: m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text });
      for (const fn of listeners) fn(m);
    });
    // Network.loadingFailed 沒有網址：以 requestWillBeSent 對照
    const reqUrl = new Map();
    listeners.push((m) => {
      if (m.method === "Network.requestWillBeSent") reqUrl.set(`${m.sessionId}|${m.params.requestId}`, m.params.request.url);
      if (m.method === "Network.loadingFailed" && m.params.blockedReason) {
        const last = evidence.blocked[evidence.blocked.length - 1];
        if (last && last.requestId === m.params.requestId) last.url = reqUrl.get(`${m.sessionId}|${m.params.requestId}`) || "";
      }
    });
    const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      waiters.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)));
      bws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const BLOCK = ["*fonts.googleapis.com*", "*fonts.gstatic.com*"];
    const enableAll = async (sid) => {
      await cdp("Network.enable", {}, sid);
      await cdp("Network.setBlockedURLs", { urls: BLOCK }, sid);
      await cdp("Page.enable", {}, sid);
      await cdp("Runtime.enable", {}, sid);
      await cdp("Log.enable", {}, sid);
      await cdp("Audits.enable", {}, sid);
    };

    async function openPage(name, url) {
      const { browserContextId } = await cdp("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      sessionLabel.set(sessionId, name);
      const page = { name, sessionId, targetId, frames: new Map() };
      listeners.push(async (m) => {
        if (m.method === "Target.attachedToTarget" && m.sessionId === sessionId && m.params.targetInfo.type === "iframe") {
          const fs = m.params.sessionId;
          sessionLabel.set(fs, `${name}／iframe`);
          page.frames.set(fs, m.params.targetInfo);
          try {
            await enableAll(fs);
            await cdp("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }, fs);
          } catch { /* 目標已關閉 */ }
          try { await cdp("Runtime.runIfWaitingForDebugger", {}, fs); } catch {}
        }
        if (m.method === "Target.detachedFromTarget" && m.sessionId === sessionId) page.frames.delete(m.params.sessionId);
      });
      await enableAll(sessionId);
      await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
      page.eval = async (expr) => {
        const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`${name} eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      };
      page.frameEval = async (prefix, expr) => {
        for (const fs of [...page.frames.keys()].reverse()) {
          try {
            const href = (await cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }, fs)).result.value;
            if (typeof href === "string" && href.startsWith(prefix)) {
              const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, fs);
              if (r.exceptionDetails) throw new Error(`${name} frameEval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
              return r.result.value;
            }
          } catch (e) { if (String(e.message).includes("frameEval")) throw e; }
        }
        return undefined;
      };
      page.shot = async (file) => { const r = await cdp("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(join(SHOTS, file), Buffer.from(r.data, "base64")); };
      page.close = () => cdp("Target.closeTarget", { targetId }).catch(() => {});
      await cdp("Page.navigate", { url }, sessionId);
      return page;
    }
    const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(150); } return false; };
    const iframeSrc = (p) => p.eval(`document.getElementById('deck').getAttribute('src')`);
    const readyFlag = (p) => p.eval(`document.getElementById('deck').dataset.ready || ''`);
    const lastSeek = async (p, prefix) => {
      const got = (await p.frameEval(prefix, `window.__pttGot`)) || [];
      const s = got.filter((g) => g.fromParent && g.data && g.data.type === "seek").map((g) => g.data.t);
      return s.length ? s[s.length - 1] : -1;
    };

    // ===== 三份合格簡報：顯示、時間同步、功能 =====
    for (const d of decks) {
      phase = d.name;
      const T = await openPage(`${d.name}講師`, `${L}/live?code=${d.room.code}#key=${encodeURIComponent(d.room.key)}`);
      const S = await openPage(`${d.name}研習者`, `${L}/live?code=${d.room.code}`);
      const entry = `${d.base}index.html`;
      ok(await waitFor(async () => (await iframeSrc(S)) === `${entry}?embed=1`), `${d.name}：研習者 iframe 指向簡報主機 entry（?embed=1）`);
      ok(await waitFor(async () => (await readyFlag(T)) === "1" && (await readyFlag(S)) === "1", 20000), `${d.name}：講師與研習者都收到簡報的 ready（新 CSP 下簡報正常載入）`);
      const env = await S.frameEval(entry, `({ origin: self.origin, cspv: window.__cspv.slice(), w: document.documentElement.getBoundingClientRect().width,
        ds: Object.assign({}, document.body.dataset) })`);
      ok(env?.origin === "null" && env.w > 100, `${d.name}：在不透明 origin 中顯示（origin=${env?.origin}、寬 ${Math.round(env?.w || 0)}）`);
      // 時間同步：講師播放 → 研習者收到的 seek 跟著走
      await T.eval(`document.getElementById('play').click(); true`);
      await sleep(2600);
      const tT = await lastSeek(T, entry), tS = await lastSeek(S, entry);
      ok(tT > 1.5 && tS > 1.5 && Math.abs(tT - tS) < 0.8, `${d.name}：講師播放 2.6 秒後兩端時間同步（講師 ${tT.toFixed(2)}／研習者 ${tS.toFixed(2)}）`);
      await T.eval(`document.getElementById('play').click(); true`); // 暫停
      await S.shot(`${d.up.id}-student.png`);

      if (d.name === "多檔測試簡報") {
        const ds = await S.frameEval(entry, `Object.assign({}, document.body.dataset)`);
        ok(ds?.module === "ok" && ds?.font === "ok" && ds?.img === "ok", `多檔測試簡報：module=${ds?.module} font=${ds?.font} img=${ds?.img}`);
      }
      if (d.name === "範例動畫簡報") {
        const board = await S.frameEval(entry, `({ embed: document.documentElement.classList.contains('embed'), w: document.querySelector('.board')?.getBoundingClientRect().width || 0 })`);
        ok(board?.embed && board.w > 100, `範例動畫簡報：嵌入模式、舞台寬 ${Math.round(board?.w || 0)}`);
      }
      if (d.name === "合格功能樣本") {
        const ds = await S.frameEval(entry, `Object.assign({}, document.body.dataset)`);
        ok(ds?.module === "ok", `合格功能樣本：兩層 module 鏈載入（module=${ds?.module}）`);
        ok(ds?.json === "ok", `合格功能樣本：fetch 自己的 JSON（json=${ds?.json}）`);
        ok(ds?.dataimg === "ok" && ds?.datafont === "ok", `合格功能樣本：data: 圖片與 data: 字型（dataimg=${ds?.dataimg} datafont=${ds?.datafont}）`);
        ok(ds?.audio === "ok" && ds?.video === "ok", `合格功能樣本：mp3 與 mp4 載入中繼資料（audio=${ds?.audio} video=${ds?.video}）`);
        const play = await S.frameEval(entry, `window.__ffPlay()`);
        ok(play?.audio === "playing" && play?.video === "playing", `合格功能樣本：mp3 與 mp4 可播放（audio=${play?.audio} video=${play?.video}）`);
        ok(Number(ds?.t) > 1.5, `合格功能樣本：研習者畫面時間跟著 seek 改變（data-t=${Number(ds?.t).toFixed(2)}）`);
        // 第 2 頁：html 頁
        await T.eval(`document.getElementById('next').click(); true`);
        const about = `${d.base}pages/about.html`;
        ok(await waitFor(async () => (await iframeSrc(S)) === about), "合格功能樣本：研習者跟隨到 html 頁（pages/about.html）");
        ok(await waitFor(async () => (await S.frameEval(about, `(async () => document.readyState === 'complete' && document.title === 'About page' && (await document.fonts.load('16px "FF Data Mono"')).length > 0 && getComputedStyle(document.body).backgroundColor === 'rgb(13, 17, 23)')()`)) === true),
          "合格功能樣本：html 頁在新 CSP 下顯示（標題、共用 CSS、data: 字型）");
        // 第 3 頁：第 2 段動畫（絕對時間 5–10 秒）
        await T.eval(`document.getElementById('next').click(); true`);
        ok(await waitFor(async () => { const s = await S.frameEval(entry, `[document.body.dataset.seg, document.body.dataset.t]`); return s && s[0] === "1" && Number(s[1]) >= 5 && Number(s[1]) < 10; }, 12000),
          "合格功能樣本：研習者跟隨到第 2 段動畫（時間 5–10 秒）");
        // 第 4 頁：討論頁（平台渲染）
        await T.eval(`document.getElementById('next').click(); true`);
        ok(await waitFor(async () => (await S.eval(`!document.getElementById('disc').hidden && document.getElementById('board').textContent.includes('合格功能樣本是否正常')`)) === true),
          "合格功能樣本：研習者跟隨到討論頁（平台渲染投票板）");
        await S.shot("full-features-disc.png");
      }
      const cspv = await S.frameEval(entry, `window.__cspv`).catch(() => null);
      if (Array.isArray(cspv) && cspv.length) info(`${d.name}：頁內 securitypolicyviolation：${cspv.join(" | ")}`);
      await T.close(); await S.close();
    }

    // ---- 合格簡報階段的 CSP 證據 ----
    const legit = (x) => decks.some((d) => x.where.startsWith(d.name));
    const legitIssues = evidence.cspIssues.filter(legit);
    const legitCspBlocked = evidence.blocked.filter((b) => legit(b) && b.reason === "csp");
    const legitConsole = evidence.consoleCsp.filter(legit);
    ok(legitIssues.length === 0, `三份合格簡報（含主站 live 頁）：Audits 沒有任何 CSP 違規${legitIssues.length ? "：" + legitIssues.map((i) => `${i.where} ${i.directive} ${i.url}`).join(" | ") : ""}`);
    ok(legitCspBlocked.length === 0, `三份合格簡報：沒有被 CSP 擋下的請求（blockedReason=csp）${legitCspBlocked.length ? "：" + legitCspBlocked.map((b) => `${b.where} ${b.url}`).join(" | ") : ""}`);
    ok(legitConsole.length === 0, `三份合格簡報：主控台沒有 CSP 違規訊息${legitConsole.length ? "：" + legitConsole.map((c) => `${c.where} ${c.text}`).join(" | ") : ""}`);
    const fontBlocks = evidence.blocked.filter((b) => /fonts\.(googleapis|gstatic)\.com/.test(b.url || ""));
    ok(fontBlocks.length > 0 && fontBlocks.every((b) => b.reason === "inspector"), `Google Fonts 由 Network.setBlockedURLs 攔截：${fontBlocks.length} 筆，blockedReason 都是 inspector（${[...new Set(fontBlocks.map((b) => b.reason))].join(",")}）`);
    const otherBlocks = evidence.blocked.filter((b) => legit(b) && !/fonts\.(googleapis|gstatic)\.com/.test(b.url || ""));
    ok(otherBlocks.length === 0, `合格簡報階段沒有 Google Fonts 以外被擋的請求${otherBlocks.length ? "：" + otherBlocks.map((b) => `${b.reason} ${b.url}`).join(" | ") : ""}`);
    const legitExc = evidence.exceptions.filter(legit);
    ok(legitExc.length === 0, `合格簡報階段沒有未處理的例外${legitExc.length ? "：" + legitExc.map((e) => `${e.where} ${e.text}`).join(" | ") : ""}`);
    if (evidence.unknownDirective.length) for (const u of evidence.unknownDirective) info(`未知指令警告（另列，不算違規）：${u.where}｜${u.text}`);
    else info("未知指令警告：無");

    // ===== 其他 origin 嵌入簡報主機頁 → 被 frame-ancestors 擋下 =====
    const target = `${decks[1].base}index.html`;
    for (const embedOrigin of [`http://127.0.0.1:${EMBED_PORT}`, `http://localhost:${EMBED_PORT}`]) {
      phase = `嵌入 ${embedOrigin}`;
      const before = { issues: evidence.cspIssues.length, console: evidence.consoleCsp.length };
      const E = await openPage(`嵌入頁 ${embedOrigin}`, `${embedOrigin}/embed?u=${encodeURIComponent(target)}`);
      await waitFor(async () => (await E.eval(`document.readyState`)) === "complete", 8000);
      await sleep(2500);
      const tree = await cdp("Page.getFrameTree", {}, E.sessionId);
      const kids = (tree.frameTree.childFrames || []).map((c) => ({ name: c.frame.name, url: c.frame.url, unreachable: c.frame.unreachableUrl || "" }));
      const issues = evidence.cspIssues.slice(before.issues).filter((i) => i.directive === "frame-ancestors");
      const cons = evidence.consoleCsp.slice(before.console).filter((c) => /frame-ancestors/.test(c.text));
      // 被擋下的 frame 不會留在簡報主機的文件上（Chrome 換成錯誤頁）；也不會有簡報主機文件的 iframe 目標可執行
      const loadedDeckDocs = [];
      for (const fs of E.frames.keys()) {
        try {
          const r = await cdp("Runtime.evaluate", { expression: "location.href + '|' + document.title", returnByValue: true }, fs);
          if (String(r.result.value).startsWith(D)) loadedDeckDocs.push(r.result.value);
        } catch {}
      }
      info(`${embedOrigin}：子 frame ${JSON.stringify(kids)}；Audits frame-ancestors ${issues.length} 筆；主控台 ${cons.length} 筆${cons[0] ? "（" + cons[0].text.slice(0, 160) + "）" : ""}`);
      const iframeCount = await E.eval(`document.querySelectorAll('iframe').length`);
      ok(iframeCount === 2 && kids.every((k) => !k.url.startsWith(D)), `${embedOrigin} 嵌入簡報主機頁（sandbox 與一般 iframe 各一）：frame 樹中沒有停在簡報主機文件上的 frame（iframe ${iframeCount} 個、frame 樹子節點 ${kids.length} 個）`);
      ok(loadedDeckDocs.length === 0, `${embedOrigin}：沒有任何簡報主機文件在嵌入頁中執行${loadedDeckDocs.length ? "：" + loadedDeckDocs.join(" | ") : ""}`);
      ok(issues.length + cons.length >= 2, `${embedOrigin}：瀏覽器端證據顯示被 frame-ancestors 擋下（Audits ${issues.length}、主控台 ${cons.length}）`);
      await E.shot(`embed-${new URL(embedOrigin).hostname}.png`);
      await E.close();
    }
    // 對照：主站 live 頁（http://localhost:8861）能嵌入同一份簡報（上面多檔測試簡報的 ready 已證明）；這裡再確認簡報主機回應的 frame-ancestors
    ok(cspDirectives((await req(D, `/${decks[1].up.uploadId}/index.html`)).headers["content-security-policy"]).get("frame-ancestors") === stack.mainOrigin,
      `對照：簡報主機的 frame-ancestors 只允許 ${stack.mainOrigin}（主站 live 頁嵌入正常）`);
    console.log(`截圖：${SHOTS}`);
    try { bws.close(); } catch {}
  } finally {
    if (chrome?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
    stack.stop();
    if (embedSrv) embedSrv.close();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

try { await run(); } catch (e) { ok(false, String(e?.stack || e)); }
console.log(failed ? `\n${failed} 項失敗（${passed} 項通過）` : `\n全部通過（${passed} 項）`);
process.exit(failed ? 1 : 0);
