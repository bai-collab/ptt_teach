// 隔離載入（S3d-B）CDP 測試：以真實 Chrome 驗證 live 頁的簡報 iframe 隔離與 postMessage 協定（契約 §3）。
// - 自己啟動主站（127.0.0.1:8831，瀏覽器以 http://localhost:8831 開）與簡報主機（127.0.0.1:8832），共用本機 R2；
//   以真實三步 API 上傳兩份範例簡報（examples/decks/ai-era-education、examples/decks/multi-file-test）後建場。
// - Chrome 以 headless、獨立使用者資料夾、除錯埠 9373 啟動；只關自己啟動的程序樹。
// - 為避免對外連線，封鎖 fonts.googleapis.com／fonts.gstatic.com（字型改用後備字型，不影響協定）。
// 驗證：iframe 的 sandbox／referrerpolicy／src、不透明 origin 下 cookie／storage／父頁 DOM 都不可用、
// 多檔簡報（module、CSS、字型、圖片）在 sandbox 下正常、跟隨模式時間同步、偽造的 ready／seek 被忽略、
// 主站送出的訊息只含 ptt、type、t、簡報傳來的 error code 不顯示。
// 用法：node scripts/e2e-isolation.mjs（環境變數 CHROME 可指定 chrome.exe 路徑）
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStack, adminLogin, uploadDeckDir, createRoom, req, sleep, root } from "./smoke-deckhost.mjs";

const CDP_PORT = 9373;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOTS = join(root, ".wrangler", "e2e-isolation-shots");
mkdirSync(SHOTS, { recursive: true });

let failed = 0, passed = 0;
const ok = (c, l) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (c) passed++; else failed++; };

// 在 iframe 文件的任何腳本之前執行：記錄收到的每則訊息（來源是否為父頁、鍵名、內容），並觀察 body 的 data-t
const INSTRUMENT = `(() => {
  window.__pttGot = [];
  window.__pttTs = [];
  addEventListener('message', (e) => {
    let rec;
    try { rec = { fromParent: e.source === window.parent, keys: e.data && typeof e.data === 'object' ? Object.keys(e.data).sort() : null, data: JSON.parse(JSON.stringify(e.data)) }; }
    catch { rec = { fromParent: e.source === window.parent, keys: null, data: '[unserializable]' }; }
    window.__pttGot.push(rec);
  }, true);
  const watch = () => {
    if (!document.body) return setTimeout(watch, 10);
    new MutationObserver(() => { const t = document.body.dataset.t; if (t !== undefined) window.__pttTs.push(Number(t)); })
      .observe(document.body, { attributes: true, attributeFilter: ['data-t'] });
  };
  watch();
})();`;

async function run() {
  const stack = await startStack({ tag: "e2e-isolation", mainPort: 8831, deckPort: 8832 });
  console.log(`實例：主站 ${stack.mainBase}（PID ${stack.pids[0]}）、簡報主機 ${stack.deckBase}（PID ${stack.pids[1]}）`);
  const profile = mkdtempSync(join(tmpdir(), "ptt-iso-"));
  let chrome = null;
  try {
    const M = stack.mainBase, D = stack.deckBase, L = stack.mainLocal;
    const A = await adminLogin(M);
    const sample = await uploadDeckDir(M, A, join(root, "examples", "decks", "ai-era-education"));
    const multi = await uploadDeckDir(M, A, join(root, "examples", "decks", "multi-file-test"));
    const r1 = (await createRoom(M, A, { deckId: multi.id, version: multi.version })).data;
    const r2 = (await createRoom(M, A, { deckId: sample.id, version: sample.version })).data;
    ok(!!r1?.code && !!r2?.code, `以兩份上傳的簡報建場（${r1?.code}、${r2?.code}）`);
    const base1 = `${D}/${multi.uploadId}/`, base2 = `${D}/${sample.uploadId}/`;

    // ---- Chrome ----
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    let ver;
    for (let i = 0; i < 60 && !ver; i++) { await sleep(250); try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {} }
    if (!ver) throw new Error("Chrome 未啟動");
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener("open", r));
    let seq = 0;
    const waiters = new Map();
    const listeners = [];
    bws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
      for (const fn of listeners) fn(m);
    });
    const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = ++seq;
      waiters.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)));
      bws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const BLOCK = ["*fonts.googleapis.com*", "*fonts.gstatic.com*"];

    async function openPage(name, url) {
      const { browserContextId } = await cdp("Target.createBrowserContext", { disposeOnDetach: true });
      const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      const page = { name, sessionId, frames: new Map(), errors: [], logs: [] };
      listeners.push(async (m) => {
        if (m.method === "Target.attachedToTarget" && m.sessionId === sessionId && m.params.targetInfo.type === "iframe") {
          const fs = m.params.sessionId;
          page.frames.set(fs, m.params.targetInfo);
          try {
            await cdp("Network.enable", {}, fs);
            await cdp("Network.setBlockedURLs", { urls: BLOCK }, fs);
            await cdp("Page.enable", {}, fs);
            await cdp("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }, fs);
            await cdp("Runtime.enable", {}, fs);
          } catch { /* 目標已關閉 */ }
          try { await cdp("Runtime.runIfWaitingForDebugger", {}, fs); } catch {}
        }
        if (m.method === "Target.detachedFromTarget" && m.sessionId === sessionId) page.frames.delete(m.params.sessionId);
        if (m.sessionId === sessionId && m.method === "Runtime.exceptionThrown") page.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
        if (m.sessionId === sessionId && m.method === "Log.entryAdded" && m.params.entry.level === "error") page.logs.push(`${m.params.entry.text} ${m.params.entry.url || ""}`);
      });
      await cdp("Network.enable", {}, sessionId);
      await cdp("Network.setBlockedURLs", { urls: BLOCK }, sessionId);
      await cdp("Page.enable", {}, sessionId);
      await cdp("Runtime.enable", {}, sessionId);
      await cdp("Log.enable", {}, sessionId);
      await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
      page.eval = async (expr) => {
        const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`${name} eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      };
      // 在目前的簡報 iframe 文件中執行（找網址符合 prefix 的 iframe 目標）
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
      await cdp("Page.navigate", { url }, sessionId);
      return page;
    }
    const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(150); } return false; };
    const iframeAttr = (p, a) => p.eval(`document.getElementById('deck').getAttribute(${JSON.stringify(a)})`);
    const readyFlag = (p) => p.eval(`document.getElementById('deck').dataset.ready || ''`);

    // ===== 場次 1：多檔測試簡報（講師＋跟隨中的研習者）=====
    const T = await openPage("講師", `${L}/live?code=${r1.code}#key=${encodeURIComponent(r1.key)}`);
    const S = await openPage("研習者", `${L}/live?code=${r1.code}`);
    ok(await waitFor(async () => (await iframeAttr(T, "src")) === `${base1}index.html?embed=1`), `講師：iframe src＝簡報主機網址＋entry＋?embed=1（${await iframeAttr(T, "src")}）`);
    ok((await iframeAttr(T, "sandbox")) === "allow-scripts", "DOM：iframe 的 sandbox 屬性完全等於 \"allow-scripts\"");
    ok((await T.eval(`document.getElementById('deck').sandbox.length`)) === 1, "DOM：sandbox 只有一個權杖（沒有 allow-same-origin 等）");
    ok((await iframeAttr(T, "referrerpolicy")) === "no-referrer", "DOM：iframe 的 referrerpolicy 為 no-referrer");
    ok(await waitFor(async () => (await readyFlag(T)) === "1" && (await readyFlag(S)) === "1", 15000), "講師與研習者都收到簡報的第一則 ready");

    const F1 = `${base1}index.html`;
    const env1 = await T.frameEval(F1, `({ origin: self.origin, referrer: document.referrer,
      cookie: (() => { try { document.cookie; return 'readable'; } catch (e) { return e.name; } })(),
      storage: (() => { try { localStorage.length; return 'readable'; } catch (e) { return e.name; } })(),
      parentDom: (() => { try { return parent.document ? 'readable' : 'none'; } catch (e) { return e.name; } })(),
      module: document.body.dataset.module, font: document.body.dataset.font, img: document.body.dataset.img,
      embed: location.search })`);
    ok(env1?.origin === "null", `簡報在不透明 origin 中執行（self.origin＝${env1?.origin}）`);
    ok(env1?.cookie === "SecurityError" && env1?.storage === "SecurityError", `簡報無法讀 cookie／localStorage（${env1?.cookie}／${env1?.storage}）`);
    ok(env1?.parentDom === "SecurityError", `簡報無法存取父頁 DOM（${env1?.parentDom}）`);
    ok(env1?.referrer === "", "簡報沒有收到 referrer");
    ok(env1?.module === "ok" && env1?.font === "ok" && env1?.img === "ok", `多檔簡報在 sandbox 下正常：module=${env1?.module} font=${env1?.font} img=${env1?.img}`);

    // 跟隨模式時間同步：講師按播放，研習者的簡報時間跟著走
    await T.eval(`document.getElementById('play').click(); true`);
    await sleep(2600);
    const tT = Number(await T.frameEval(F1, `document.body.dataset.t`));
    const tS = Number(await S.frameEval(F1, `document.body.dataset.t`));
    ok(tT > 1.5 && tT <= 5.6, `講師播放 2.6 秒後簡報時間 ${tT.toFixed(2)}（第 1 段 0–6 秒內）`);
    ok(tS > 1.5 && Math.abs(tT - tS) < 0.8, `跟隨中的研習者時間同步（講師 ${tT.toFixed(2)}／研習者 ${tS.toFixed(2)}）`);
    await T.shot("t-multi-anim.png");

    // 第 2 頁是 html 頁（slides/intro.html）→ 第 3 頁是第 2 段動畫（絕對時間 6–14 秒）
    await T.eval(`document.getElementById('next').click(); true`);
    ok(await waitFor(async () => (await iframeAttr(S, "src")) === `${base1}slides/intro.html`), "研習者跟隨到 html 頁：iframe 換成 slides/intro.html");
    ok(await waitFor(async () => (await S.frameEval(`${base1}slides/intro.html`, `(() => { const i = document.querySelector('img'); return document.title === 'Intro slide' && i.complete && i.naturalWidth > 0 && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'; })()`)) === true),
      "html 頁在 sandbox 下顯示（標題、共用 CSS、圖片）");
    await S.shot("s-multi-html.png");
    ok((await readyFlag(S)) === "0", "換到 html 頁後重設 ready 狀態");
    await T.eval(`document.getElementById('next').click(); true`);
    ok(await waitFor(async () => { const s = await S.frameEval(F1, `[document.body.dataset.seg, document.body.dataset.t]`); return s && s[0] === "1" && Number(s[1]) >= 6 && Number(s[1]) < 14; }, 12000),
      "研習者跟隨到第 2 段動畫：簡報時間落在 6–14 秒（依 deck.json segments 換算絕對時間）");
    await T.eval(`document.getElementById('play').click(); true`); // 暫停
    await sleep(600);
    const p1 = Number(await S.frameEval(F1, `document.body.dataset.t`));
    await sleep(1200);
    const p2 = Number(await S.frameEval(F1, `document.body.dataset.t`));
    ok(Math.abs(p1 - p2) < 0.01, `講師暫停後研習者時間停住（${p1.toFixed(2)} → ${p2.toFixed(2)}）`);

    // 主站送出的訊息：只含 ptt、type、t（研習者與講師兩端都檢查）
    for (const P of [S, T]) {
      const got = await P.frameEval(F1, `window.__pttGot`);
      const fromHost = (got || []).filter((g) => g.fromParent);
      const allOk = fromHost.length > 0 && fromHost.every((g) => Array.isArray(g.keys) && g.keys.join(",") === "ptt,t,type" && g.data.ptt === 1 && g.data.type === "seek" && typeof g.data.t === "number");
      ok(allOk, `${P.name}：主站送給簡報的 ${fromHost.length} 則訊息都只有 ptt、type、t（type＝seek）`);
    }

    // ---- 偽造的 seek：從同頁另一個視窗（主站自己的 helper iframe）送給簡報 → 簡報忽略 ----
    await T.eval(`(() => { const f = document.createElement('iframe'); f.id = 'helper'; f.name = 'helper'; f.src = 'about:blank'; f.style.display = 'none'; document.body.append(f); return true; })()`);
    await sleep(200);
    const tree = await cdp("Page.getFrameTree", {}, T.sessionId);
    const helperFrame = (tree.frameTree.childFrames || []).find((c) => c.frame.name === "helper");
    const helperWorld = helperFrame ? (await cdp("Page.createIsolatedWorld", { frameId: helperFrame.frame.id, worldName: "forge" }, T.sessionId)).executionContextId : null;
    const helperEval = (expr) => cdp("Runtime.evaluate", { expression: expr, contextId: helperWorld, returnByValue: true }, T.sessionId);
    ok(!!helperWorld, "建立同頁的另一個視窗（helper iframe）供偽造訊息");
    const beforeForge = (await T.frameEval(F1, `window.__pttTs.length`)) || 0;
    await helperEval(`parent.document.getElementById('deck').contentWindow.postMessage({ ptt: 1, type: 'seek', t: 15 }, '*'); true`);
    await sleep(700);
    const forged = await T.frameEval(F1, `({ got: window.__pttGot.filter((g) => !g.fromParent && g.data && g.data.t === 15).length, ts: window.__pttTs.slice(${beforeForge}) })`);
    ok(forged?.got === 1 && !forged.ts.includes(15), `偽造的 seek（來源不是父頁）送達但被簡報忽略（畫面時間未出現 15）`);
    // 對照：父頁送出的 seek 15 會被採用（證明上面的觀察方式有效）
    await T.eval(`document.getElementById('deck').contentWindow.postMessage({ ptt: 1, type: 'seek', t: 15 }, '*'); true`);
    ok(await waitFor(async () => (await T.frameEval(F1, `window.__pttTs.includes(15)`)) === true, 3000), "對照：父頁送出的 seek 會被簡報採用");

    // ---- 偽造的 ready：講師翻到 html 頁（ready 重設為 0，該頁不會送 ready）----
    await T.eval(`document.getElementById('prev').click(); true`); // 回到第 2 頁（html）
    ok(await waitFor(async () => (await iframeAttr(T, "src")) === `${base1}slides/intro.html` && (await readyFlag(T)) === "0"), "講師在 html 頁，ready＝0");
    const FI = `${base1}slides/intro.html`;
    await waitFor(async () => (await T.frameEval(FI, `document.readyState`)) === "complete");
    const toastText = () => T.eval(`document.getElementById('toast').textContent`);
    await T.eval(`document.getElementById('toast').textContent = ''; true`);
    await T.eval(`window.postMessage({ ptt: 1, type: 'ready', duration: 999 }, '*'); true`);
    await helperEval(`parent.postMessage({ ptt: 1, type: 'ready', duration: 999 }, '*'); true`);
    await sleep(500);
    ok((await readyFlag(T)) === "0" && !(await toastText()).includes("deck.json"), "偽造的 ready（來自主站頁本身與另一個視窗）被忽略");
    // 不合格的訊息（來自真正的 iframe）一律丟棄
    await T.frameEval(FI, `[{ ptt: 2, type: 'ready', duration: 20 }, { ptt: 1, type: 'ready', duration: '20' }, { ptt: 1, type: 'ready', duration: -1 },
      { ptt: 1, type: 'ready', duration: 1e9 }, { ptt: 1, type: 'ready' }, [1, 2], 'ready', null].forEach((m) => parent.postMessage(m, '*')); true`);
    await sleep(500);
    ok((await readyFlag(T)) === "0", "格式不合格的 ready（版本、型別、範圍、陣列、字串）被丟棄");
    // error 的 code 只記錄、不顯示
    await T.frameEval(FI, `parent.postMessage({ ptt: 1, type: 'error', code: 'load_failed' }, '*'); parent.postMessage({ ptt: 1, type: 'error', code: '<img src=x onerror=window.__pwned=1>' }, '*'); true`);
    await sleep(400);
    const shown = await T.eval(`({ text: document.body.innerText, pwned: !!window.__pwned, imgs: document.querySelectorAll('img').length })`);
    ok(!shown.text.includes("load_failed") && !shown.text.includes("onerror") && !shown.pwned && shown.imgs === 0, "簡報傳來的 error code 不顯示、不進 DOM");
    // 對照：真正的 iframe 送出的第一則合格 ready 被採用（duration 與 deck.json 不同 → 講師看到警告）
    await T.frameEval(FI, `parent.postMessage({ ptt: 1, type: 'ready', duration: 999 }, '*'); true`);
    ok(await waitFor(async () => (await readyFlag(T)) === "1" && (await toastText()).includes("以 deck.json 為準"), 3000), "對照：本 iframe 的第一則 ready 被採用（長度不符時講師看到警告）");
    await T.eval(`document.getElementById('toast').textContent = ''; true`);
    await T.frameEval(FI, `parent.postMessage({ ptt: 1, type: 'ready', duration: 999 }, '*'); true`);
    await sleep(500);
    ok((await toastText()) === "", "同一次載入的第二則 ready 被忽略");
    // 簡報送 seek 給主站：主站沒有這種訊息，不影響講師狀態
    const pageBefore = await T.eval(`document.getElementById('pageInfo').textContent`);
    await T.frameEval(FI, `parent.postMessage({ ptt: 1, type: 'seek', t: 3 }, '*'); true`);
    await sleep(300);
    ok((await T.eval(`document.getElementById('pageInfo').textContent`)) === pageBefore, "簡報送給主站的 seek 不影響主站");

    // ===== 場次 2：範例動畫簡報（ai-era-education）=====
    const T2 = await openPage("講師2", `${L}/live?code=${r2.code}#key=${encodeURIComponent(r2.key)}`);
    const S2 = await openPage("研習者2", `${L}/live?code=${r2.code}`);
    ok(await waitFor(async () => (await iframeAttr(S2, "src")) === `${base2}index.html?embed=1`), "範例簡報：研習者 iframe 指向簡報主機");
    ok(await waitFor(async () => (await readyFlag(T2)) === "1" && (await readyFlag(S2)) === "1", 20000), "範例簡報：講師與研習者都收到 ready");
    const F2 = `${base2}index.html`;
    const env2 = await S2.frameEval(F2, `({ origin: self.origin, embed: document.documentElement.classList.contains('embed'), board: !!document.querySelector('.board'), w: document.querySelector('.board')?.getBoundingClientRect().width || 0 })`);
    ok(env2?.origin === "null" && env2?.embed && env2?.board && env2.w > 100, `範例簡報在 sandbox 下以嵌入模式顯示（origin=${env2?.origin}、embed=${env2?.embed}、舞台寬 ${Math.round(env2?.w || 0)}）`);
    await T2.eval(`document.getElementById('play').click(); true`);
    await sleep(2600);
    const seeks = (await S2.frameEval(F2, `window.__pttGot.filter((g) => g.fromParent && g.data && g.data.type === 'seek').map((g) => g.data.t)`)) || [];
    const lastT = seeks.length ? seeks[seeks.length - 1] : -1;
    ok(lastT > 1.5 && lastT < 10, `範例簡報：講師播放後研習者收到遞增的 seek（最後 t＝${lastT.toFixed(2)}，共 ${seeks.length} 則）`);
    const got2 = (await S2.frameEval(F2, `window.__pttGot`)) || [];
    ok(got2.filter((g) => g.fromParent).every((g) => g.keys?.join(",") === "ptt,t,type"), "範例簡報：主站送出的訊息只有 ptt、type、t");
    await S2.shot("s2-ai-era-anim.png");
    await T2.shot("t2-ai-era-anim.png");

    // 主控台：主站頁沒有未處理的例外
    for (const P of [T, S, T2, S2]) ok(P.errors.length === 0, `${P.name}：主站頁沒有未處理的例外${P.errors.length ? "：" + P.errors.join(" | ") : ""}`);
    const nonFont = [T, S, T2, S2].flatMap((P) => P.logs).filter((l) => !/fonts\.(googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT|\/favicon\.ico/.test(l));
    ok(nonFont.length === 0, `主站頁沒有字型封鎖與 favicon（既有 404，與本片無關）以外的錯誤紀錄${nonFont.length ? "：" + nonFont.join(" | ") : ""}`);
    console.log(`截圖：${SHOTS}`);
    try { bws.close(); } catch {}
  } finally {
    if (chrome?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
    stack.stop();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

try { await run(); } catch (e) { ok(false, String(e?.stack || e)); }
console.log(failed ? `\n${failed} 項失敗（${passed} 項通過）` : `\n全部通過（${passed} 項）`);
process.exit(failed ? 1 : 0);
