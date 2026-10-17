// S4-B 惡意簡報樣本庫的真實瀏覽器實測。
// 直接執行（node scripts/e2e-malicious.mjs）時：啟動真實 stack（主站＋簡報主機，CSP 由 S4-A 定稿）、本機收件端（canary）與 Chrome，
// 以真實三步 API 上傳每個樣本、講師建場、研習者加入，在 live 頁中執行樣本，對 M1–M18 逐項輸出攻擊／預期／實際／證據。
//
// 同時匯出給對照組（workspace/ptt-teach-split/e2e/e2e-malicious-controls.mjs）共用：
//   - SAMPLES：樣本清單（id／目錄／標題／類型／預期）
//   - DETECTORS：每個樣本的具名偵測器（同一份程式，對照組印出的名稱必與這裡一致）
//   - runSuite({ browser, deckOrigin, mainOrigin, canary, embed, samples })：以呼叫方傳入的目標執行整套樣本
//   - createBrowser(wsUrl)：CDP 連線與 openPage 工具
//   - 連線埠常數
//
// 安全底線：本檔沒有任何能停用或放寬 CSP 或 sandbox 的旗標；對外目標一律只來自呼叫方參數（__pttTargets 由測試注入）。
// 只關自己啟動的程序樹（wrangler 兩個、Chrome）與自己開的伺服器；不碰 8791／8801。
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startStack, adminLogin, uploadDeckDir, createRoom, req, sleep, root } from "./smoke-deckhost.mjs";
import { startCanary } from "./canary.mjs";

export const MAIN_PORT = 8871, DECK_PORT = 8872, CANARY_HTTP_PORT = 8873, CANARY_UDP_PORT = 8874, CDP_PORT = 9413;
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FIXTURES = join(root, "test", "fixtures", "malicious-decks");

// ---------- 樣本清單 ----------
export const SAMPLES = [
  { id: "M1", dir: "m01-exfil", title: "fetch／XHR／beacon／WebSocket／<a ping>／帶 cookie 打主站 API", type: "block", expected: "收件端與主站都沒有收到" },
  { id: "M2", dir: "m02-sameorigin-read", title: "讀 cookie／localStorage／parent.document", type: "block", expected: "SecurityError（不透明 origin）" },
  { id: "M3", dir: "m03-top-nav", title: "top.location／target=_top／form target=_top 導走頂層", type: "block", expected: "頂層網址不變（無 allow-top-navigation、form-action 'none'）" },
  { id: "M4", dir: "m04-popup", title: "window.open／target=_blank", type: "block", expected: "沒有新視窗（無 allow-popups）" },
  { id: "M5", dir: "m05-modals", title: "alert／confirm／prompt", type: "block", expected: "被擋（無 allow-modals）" },
  { id: "M6", dir: "m06-external-res", title: "載入非白名單的外部 script／style／img／font", type: "block", expected: "CSP 擋下，收件端沒有收到" },
  { id: "M7", dir: "m07-base-uri", title: "<base href> 改寫相對路徑", type: "block", expected: "base-uri 'none' 擋下" },
  { id: "M8", dir: "m08-nested-frame", title: "巢狀 iframe 嵌主站頁或收件端", type: "block", expected: "frame-src 'none' 擋下" },
  { id: "M9", dir: "m09-workers", title: "註冊 Service Worker／建立 Worker", type: "block", expected: "被擋" },
  { id: "M10", dir: "m10-forged-msg", title: "對父頁送偽造訊息（多則 ready、超大 payload、錯誤 type、error 夾 HTML）", type: "block", expected: "主站只接受第一則合格 ready，畫面沒被注入" },
  { id: "M11", dir: "m11-dos", title: "有界忙碌迴圈、配置記憶體、postMessage 洪泛", type: "measure", expected: "記錄主站能否翻頁、WebSocket 是否維持；不在本片修" },
  { id: "M12", dir: "m12-download", title: "<a download>／自動下載", type: "block", expected: "沒有下載（無 allow-downloads）" },
  { id: "M13", dir: "m13-svg-script", title: "帶 script 的 SVG 以頂層開啟", type: "block", expected: "在不透明 origin 中執行，拿不到主站資料" },
  { id: "M14", dir: "m14-webrtc", title: "WebRTC STUN 指向本機 UDP 收件端", type: "measure", expected: "記錄是否送出；若送出列為殘留風險" },
  { id: "M15", dir: "m15-prefetch", title: "dns-prefetch／preconnect／prefetch／speculation rules", type: "measure", expected: "記錄是否送出；有送出列為殘留風險" },
  { id: "M16", dir: "m16-self-nav", title: "自我導覽：location.href／meta refresh／target=_self", type: "block", expected: "主站 frame-src 擋下；收件端沒有收到" },
  { id: "M17", dir: "m17-history", title: "history.back／go(-n)／pushState 洪泛", type: "block", expected: "頂層網址不變" },
  { id: "M18", dir: "m18-permissions", title: "權限與焦點：攝影機、麥克風、定位、通知、全螢幕、pointer lock、剪貼簿、螢幕擷取、USB／HID／Serial／MIDI、payment、share、wake lock、自動播放、focus、top.close、opener", type: "block", expected: "被 sandbox 與 Permissions-Policy 擋下；grantPermissions 後仍被擋" },
];

// ---------- 具名偵測器（succeeded=攻擊成功＝未被擋）----------
// obs 的欄位見 collect()：dataset、canaryHttp、canaryUdp、topNavs、frameNavs、newTargets、dialogs、downloads、cspBlocked、cspIssues、main、svg、m11
const hitMatch = (hits, frag) => (hits || []).filter((h) => (h.url || "").includes(frag));
const navMatch = (navs, target) => (navs || []).filter((u) => typeof u === "string" && (u === target || u.startsWith(target)));

export const DETECTORS = {
  M1: { name: "exfil-http-channels", detect: (o) => {
    const hits = hitMatch(o.canaryHttp, "/m01-");
    const d = o.dataset || {};
    return { kind: "block", succeeded: hits.length > 0,
      evidence: `canary 命中 ${hits.length}（${hits.map((h) => h.url).join(",") || "無"}）；fetch=${d.fetch} xhr=${d.xhr} beacon=${d.beacon} ws=${d.ws} mainapi=${d.mainapi}；CSP 擋下 ${o.cspBlocked?.length || 0} 筆` };
  } },
  M2: { name: "same-origin-read", detect: (o) => {
    const d = o.dataset || {};
    const ok = d.cookie === "readable" || d.storage === "readable" || d.parentDom === "readable";
    return { kind: "block", succeeded: ok, evidence: `cookie=${d.cookie} storage=${d.storage} parentDom=${d.parentDom}` };
  } },
  M3: { name: "top-navigation", detect: (o) => {
    const navs = navMatch(o.topNavs, o.navTarget);
    return { kind: "block", succeeded: navs.length > 0, evidence: `頂層導覽 ${navs.length}（${o.topNavs?.join("|") || "無變化"}）；toploc=${o.dataset?.toploc}` };
  } },
  M4: { name: "popup-open", detect: (o) => {
    // 只數有 openerId 的新分頁（window.open 開出的）；測試自己開的頁沒有 opener，已在 collector 排除
    const t = (o.newTargets || []).filter((x) => x.openerId);
    return { kind: "block", succeeded: t.length > 0, evidence: `攻擊開出的分頁/視窗 ${t.length}（${t.map((x) => x.url).join(",") || "無"}）；window.open=${o.dataset?.open}（null＝被擋）` };
  } },
  M5: { name: "js-dialog", detect: (o) => {
    return { kind: "block", succeeded: (o.dialogs || []).length > 0, evidence: `對話框 ${o.dialogs?.length || 0}（${(o.dialogs || []).map((x) => x.type).join(",") || "無"}）；alert=${o.dataset?.alert}` };
  } },
  M6: { name: "external-subresource", detect: (o) => {
    const hits = hitMatch(o.canaryHttp, "/m06");
    return { kind: "block", succeeded: hits.length > 0,
      evidence: `canary 命中 ${hits.length}（${hits.map((h) => h.url).join(",") || "無"}）；CSP 擋下 ${o.cspBlocked?.length || 0} 筆；imgLoad=${o.dataset?.imgLoad} imgErr=${o.dataset?.imgErr}` };
  } },
  M7: { name: "base-uri-rewrite", detect: (o) => {
    const hits = hitMatch(o.canaryHttp, "/m07base/");
    const issue = (o.cspIssues || []).filter((i) => /base-uri/.test(i.directive || ""));
    return { kind: "block", succeeded: hits.length > 0, evidence: `收件端相對請求命中 ${hits.length}（${hits.map((h) => h.url).join(",") || "無"}）；Audits base-uri ${issue.length} 筆；baseFetch=${o.dataset?.baseFetch}` };
  } },
  M8: { name: "nested-iframe", detect: (o) => {
    const navs = (o.frameNavs || []).filter((u) => u.includes("/m08") || u.includes("/live"));
    const hits = hitMatch(o.canaryHttp, "/m08");
    const issue = (o.cspIssues || []).filter((i) => /frame-src/.test(i.directive || ""));
    return { kind: "block", succeeded: navs.length > 0 || hits.length > 0, evidence: `子 frame 導到主站/收件端 ${navs.length}；canary 命中 ${hits.length}；Audits frame-src ${issue.length} 筆` };
  } },
  M9: { name: "worker-register", detect: (o) => {
    const d = o.dataset || {};
    const exfilHit = hitMatch(o.canaryHttp, "/m09-worker-exfil").length > 0 || /fetched/.test(d.dataWorkerMsg || "");
    // 安全主張＝無身分冒用／無對外送資料。SW 註冊、classic worker、或 data: worker 能對收件端送資料才算攻擊成功。
    // data: worker 僅「能被建立」（worker-src 'none' 在 Chrome 不涵蓋 data:）但網路被 connect-src 隔離 → 記為殘留，不算攻擊成功。
    const succeeded = d.sw === "registered" || d.worker === "created" || exfilHit;
    const residual = d.dataWorker === "created" && !exfilHit ? "；殘留：data: worker 可建立但 fetch 被擋（" + (d.dataWorkerMsg || "無訊息") + "）" : "";
    return { kind: "block", succeeded, evidence: `sw=${d.sw} worker=${d.worker} dataWorker=${d.dataWorker}；收件端命中=${exfilHit}${residual}` };
  } },
  M10: { name: "forged-parent-message", detect: (o) => {
    const m = o.main;
    if (!m) return { kind: "block", succeeded: false, evidence: "此模式沒有主站頁（n/a）" };
    const injected = m.pwned || m.imgs > 0 || /load_failed|onerror/.test(m.bodyText || "");
    return { kind: "block", succeeded: injected, evidence: `主站 __pwned=${m.pwned} imgs=${m.imgs} ready=${m.ready} 畫面含注入=${/load_failed|onerror/.test(m.bodyText || "")}` };
  } },
  M11: { name: "dos-resilience", detect: (o) => {
    const m = o.m11 || {};
    const sent = false;
    return { kind: "measure", sent, evidence: `配置=${o.dataset?.alloc} 迴圈=${o.dataset?.spun}；主站翻頁=${m.pageAdvanced} WebSocket=${m.wsAlive}`,
      conclusion: `${o.browser || ""}｜${o.platform || ""}：洪泛與有界忙碌後，主站${m.pageAdvanced ? "仍能翻頁" : "無法翻頁"}、WebSocket ${m.wsAlive ? "維持" : "中斷"}` };
  } },
  M12: { name: "auto-download", detect: (o) => {
    return { kind: "block", succeeded: (o.downloads || []).length > 0, evidence: `下載 ${o.downloads?.length || 0}（${(o.downloads || []).map((x) => x.suggestedFilename || x.url).join(",") || "無"}）` };
  } },
  M13: { name: "svg-top-isolation", detect: (o) => {
    const s = o.svg;
    if (!s) return { kind: "block", succeeded: false, evidence: "此模式沒有頂層 SVG（n/a）" };
    const leaked = s.origin !== "null" || s.cookie === "readable" || s.mainapi === "sent";
    const hits = hitMatch(o.canaryHttp, "/m13-svg");
    return { kind: "block", succeeded: leaked || hits.length > 0, evidence: `origin=${s.origin} cookie=${s.cookie} mainapi=${s.mainapi} fetch=${s.fetch}；canary 命中 ${hits.length}` };
  } },
  M14: { name: "webrtc-stun", detect: (o) => {
    const udp = o.canaryUdp || [];
    const srflx = /srflx|typ srflx/.test(o.dataset?.ice || "");
    const sent = udp.length > 0;
    return { kind: "measure", sent, evidence: `UDP 收件端命中 ${udp.length}；ICE 候選=${o.dataset?.ice || "無"}；rtc=${o.dataset?.rtc}`,
      conclusion: `${o.browser || ""}｜${o.platform || ""}：WebRTC STUN ${sent ? "有送出到本機 UDP 收件端（殘留風險，不宣稱已擋）" : "未送出到本機 UDP 收件端"}${srflx ? "（含 srflx 候選）" : ""}` };
  } },
  M15: { name: "prefetch-preconnect", detect: (o) => {
    const hits = hitMatch(o.canaryHttp, "/m15-");
    const sent = hits.length > 0;
    return { kind: "measure", sent, evidence: `收件端命中 ${hits.length}（${hits.map((h) => h.url).join(",") || "無"}）`,
      conclusion: `${o.browser || ""}｜${o.platform || ""}：預取/預連線/推測規則 ${sent ? "有送出到收件端（殘留風險）" : "未送出到收件端"}` };
  } },
  M16: { name: "self-navigation", detect: (o) => {
    const navs = navMatch(o.frameNavs, o.navTarget);
    const hits = o.navHitFrag ? hitMatch(o.canaryHttp, o.navHitFrag) : [];
    return { kind: "block", succeeded: navs.length > 0 || hits.length > 0,
      evidence: `frame 導到目標 ${navs.length}（${o.frameNavs?.join("|") || "無"}）；收件端命中 ${hits.length}；loc=${o.dataset?.loc}` };
  } },
  M17: { name: "history-flood", detect: (o) => {
    const d = o.dataset || {};
    // 排除測試自己開頁的 about:blank → live 導覽；只算 top 真的離開 live 頁到攻擊可控的網址
    const bad = (o.topNavs || []).filter((u) => u && u !== "about:blank" && !String(u).startsWith("chrome-error")
      && !(o.mainOrigin && String(u).startsWith(o.mainOrigin)) && !(o.mainLocal && String(u).startsWith(o.mainLocal)));
    // pushState/replaceState 只改動 iframe 自身的 URL（同不透明 origin），不影響頂層；非安全事件
    return { kind: "block", succeeded: bad.length > 0, evidence: `頂層離開 live 頁的導覽 ${bad.length}（${bad.join("|") || "無"}）；iframe 自身 pushState=${d.pushState} replaceState=${d.replaceState}（僅改 iframe URL，不影響頂層）` };
  } },
  M18: { name: "permissions-focus", detect: (o) => {
    const d = o.dataset || {};
    // 攻擊成功＝取得「裝置／資料／媒體」存取（會造成身分或資料風險）。這些功能都在 Permissions-Policy 名單內，應被擋下。
    // 排除：notify（通知不在 Permissions-Policy，屬釣魚面殘留，不是裝置/資料存取）；focus/top.close 的 "called"＝無效果；payment "constructed"＝未 show()。
    const grantWord = { cam: "granted", screen: "granted", geo: "granted", fs: "entered", ptr: "locked", clip: "wrote", usb: "got", hid: "got", serial: "got", midi: "got", wake: "held", autoplay: "playing", share: "shared", opener: "posted" };
    const breached = Object.entries(grantWord).filter(([k, w]) => d[k] === w);
    const residual = d.notify === "granted" ? "；殘留：通知權限可被授權（不在 Permissions-Policy，屬釣魚面）" : "";
    return { kind: "block", succeeded: breached.length > 0,
      evidence: `${o.granted ? "已 grantPermissions 後 " : ""}取得的裝置/資料權限 ${breached.length}（${breached.map(([k]) => k + "=" + d[k]).join(",") || "無"}）${residual}；全部結果：${["cam", "screen", "geo", "notify", "fs", "ptr", "clip", "usb", "hid", "serial", "midi", "payment", "share", "wake", "autoplay", "focus", "topclose", "opener"].map((k) => k + "=" + (d[k] ?? "-")).join(" ")}` };
  } },
};

// ---------- CDP 瀏覽器工具（供本檔與對照組共用）----------
export async function createBrowser(wsUrl) {
  const bws = new WebSocket(wsUrl);
  await new Promise((r) => bws.addEventListener("open", r));
  let seq = 0;
  const waiters = new Map();
  const taps = new Set(); // 全域事件監聽（每個訊息都呼叫）
  const sessionLabel = new Map();
  bws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); return; }
    for (const fn of taps) { try { fn(m); } catch {} }
  });
  const cdp = (method, params = {}, sessionId, timeoutMs = 12000) => new Promise((res, rej) => {
    const id = ++seq;
    const to = setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error(method + ": CDP 逾時 " + timeoutMs + "ms")); } }, timeoutMs);
    waiters.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result); });
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

  // 開一個獨立 browser context 的新分頁；inject 會在每個新文件（含子 iframe）的腳本之前執行
  async function openPage(name, url, { inject = "", onFrame } = {}) {
    const { browserContextId } = await cdp("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    sessionLabel.set(sessionId, name);
    const page = { name, sessionId, targetId, browserContextId, frames: new Map() };
    const tap = async (m) => {
      if (m.method === "Target.attachedToTarget" && m.sessionId === sessionId && m.params.targetInfo.type === "iframe") {
        const fs = m.params.sessionId;
        sessionLabel.set(fs, `${name}/iframe`);
        page.frames.set(fs, m.params.targetInfo);
        try {
          await enableAll(fs);
          if (inject) await cdp("Page.addScriptToEvaluateOnNewDocument", { source: inject }, fs);
          if (onFrame) await onFrame(fs, m.params.targetInfo);
        } catch {}
        try { await cdp("Runtime.runIfWaitingForDebugger", {}, fs); } catch {}
      }
      if (m.method === "Target.detachedFromTarget" && m.sessionId === sessionId) page.frames.delete(m.params.sessionId);
    };
    taps.add(tap);
    page._tap = tap;
    await enableAll(sessionId);
    if (inject) await cdp("Page.addScriptToEvaluateOnNewDocument", { source: inject }, sessionId);
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
          if (typeof href === "string" && (prefix === "*" || href.startsWith(prefix))) {
            const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, fs);
            if (r.exceptionDetails) throw new Error(`${name} frameEval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
            return r.result.value;
          }
        } catch (e) { if (String(e.message).includes("frameEval:")) throw e; }
      }
      return undefined;
    };
    page.iframeRect = () => page.eval(`(() => { const f = document.getElementById('deck') || document.querySelector('iframe'); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    page.clickInto = async () => {
      const r = await page.iframeRect();
      if (!r || r.w < 2) return false;
      const x = r.x + r.w / 2, y = r.y + r.h / 2;
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 }, sessionId);
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 1 }, sessionId);
      return true;
    };
    page.close = () => { taps.delete(tap); return cdp("Target.closeTarget", { targetId }).catch(() => {}); };
    page.navigate = (u) => cdp("Page.navigate", { url: u }, sessionId);
    await page.navigate(url);
    return page;
  }

  // 瀏覽器層：探索新 target（才收得到 window.open 開出的分頁）
  await cdp("Target.setDiscoverTargets", { discover: true });
  return { bws, cdp, openPage, addTap: (fn) => { taps.add(fn); return () => taps.delete(fn); }, sessionLabel, close: () => { try { bws.close(); } catch {} } };
}

// 讀上傳檔案清單（供 room 模式上傳）
export function listDeckFiles(dir) {
  const out = [];
  const walk = (d, p = "") => { for (const n of readdirSync(d)) { const fp = join(d, n); const rp = p ? p + "/" + n : n; if (statSync(fp).isDirectory()) walk(fp, rp); else out.push(rp); } };
  walk(dir);
  return out;
}

// 一個全域事件收集器：記錄頂層導覽、frame 導覽、新 target、對話框、下載、CSP 擋下與 Audits CSP 問題。
function makeCollector(browser) {
  const ev = { topNavs: [], frameNavs: [], newTargets: [], dialogs: [], downloads: [], cspBlocked: [], cspIssues: [], reqUrl: new Map() };
  const topFrameIds = new Set();
  const off = browser.addTap((m) => {
    if (m.method === "Page.frameNavigated") {
      const f = m.params.frame;
      if (!f.parentId) ev.topNavs.push(f.url); else ev.frameNavs.push(f.url);
    }
    // 只有 window.open 開出的分頁才有 openerId；測試自己用 createTarget 開的 presenter／participant／embed 頁沒有 opener
    if (m.method === "Target.targetCreated") { const t = m.params.targetInfo; if ((t.type === "page" || t.type === "tab") && t.openerId) ev.newTargets.push({ type: t.type, url: t.url, openerId: t.openerId }); }
    if (m.method === "Page.javascriptDialogOpening") { ev.dialogs.push({ type: m.params.type, message: m.params.message }); browser.cdp("Page.handleJavaScriptDialog", { accept: false }, m.sessionId).catch(() => {}); }
    if (m.method === "Browser.downloadWillBegin") ev.downloads.push({ url: m.params.url, suggestedFilename: m.params.suggestedFilename });
    if (m.method === "Network.requestWillBeSent") ev.reqUrl.set(`${m.sessionId}|${m.params.requestId}`, m.params.request.url);
    if (m.method === "Network.loadingFailed" && m.params.blockedReason) ev.cspBlocked.push({ reason: m.params.blockedReason, url: ev.reqUrl.get(`${m.sessionId}|${m.params.requestId}`) || "" });
    if (m.method === "Audits.issueAdded" && m.params.issue.code === "ContentSecurityPolicyIssue") {
      const d = m.params.issue.details.contentSecurityPolicyIssueDetails || {};
      ev.cspIssues.push({ directive: d.violatedDirective, url: d.blockedURL || "", type: d.contentSecurityPolicyViolationType });
    }
  });
  ev.off = off;
  ev.reset = () => { for (const k of ["topNavs", "frameNavs", "newTargets", "dialogs", "downloads", "cspBlocked", "cspIssues"]) ev[k].length = 0; };
  return ev;
}

const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(150); } return false; };

// 把 __pttTargets 注入腳本組出來（目標只來自呼叫方參數）
function injectTargets(t) {
  return `window.__pttTargets = ${JSON.stringify(t)};`;
}

/**
 * runSuite：以呼叫方傳入的目標執行整套樣本。
 * ctx = { browser, deckOrigin, mainOrigin, canary, platform, browserName, embed, samples }
 *   embed.mode = "room"：經主站 live 頁載入（real 與 對照組 A）。需要 embed.openRoom(sample) -> { code, key, deckBase }；
 *                        embed.navTargetFor(sample) 與 embed.navHitFrag（M16 的目標與收件端命中片段）；embed.liveUrl(code, key?)。
 *   embed.mode = "embedpage"：經呼叫方提供的嵌入頁載入（對照組 B）。需要 embed.openEmbed(sample) -> { page, frameCheckPrefix }。
 * 回傳 results：[{ id, title, type, expected, detector, succeeded|sent, actual, evidence, conclusion? }]
 */
export async function runSuite(ctx) {
  const { browser, canary, samples, embed } = ctx;
  const col = makeCollector(browser);
  const results = [];
  for (const s of samples) {
    canary.reset(); col.reset();
    const det = DETECTORS[s.id];
    const obs = { browser: ctx.browserName, platform: ctx.platform };
    const t0 = Date.now();
    process.stdout.write(`▶ ${s.id} ${det.name} … `);
    try {
      const work = embed.mode === "room" ? runRoomSample(ctx, s, col, obs) : runEmbedSample(ctx, s, col, obs);
      const budget = s.id === "M11" ? 40000 : 30000;
      await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error(`樣本逾時 ${budget}ms`)), budget))]);
    } catch (e) { obs.error = String(e?.message || e); }
    console.log(`${Math.round((Date.now() - t0) / 100) / 10}s`);
    obs.canaryHttp = canary.hits.http.slice();
    obs.canaryUdp = canary.hits.udp.slice();
    obs.topNavs = col.topNavs.slice(); obs.frameNavs = col.frameNavs.slice();
    obs.newTargets = col.newTargets.slice(); obs.dialogs = col.dialogs.slice();
    obs.downloads = col.downloads.slice(); obs.cspBlocked = col.cspBlocked.slice(); obs.cspIssues = col.cspIssues.slice();
    obs.navTarget = embed.navTargetFor ? embed.navTargetFor(s) : null;
    obs.navHitFrag = embed.navHitFrag || null;
    obs.mainOrigin = ctx.mainOrigin; obs.mainLocal = ctx.mainLocal || ctx.mainOrigin; obs.deckOrigin = ctx.deckOrigin;
    const r = det.detect(obs);
    results.push({ id: s.id, title: s.title, type: s.type, expected: s.expected, detector: det.name,
      succeeded: r.succeeded, sent: r.sent, kind: r.kind, evidence: (obs.error ? `[執行誤差 ${obs.error}] ` : "") + r.evidence, conclusion: r.conclusion });
  }
  col.off();
  return results;
}

// room 模式：講師建場→研習者加入→樣本在 iframe 執行；收集 dataset 與 main/svg/m11 額外觀察。
async function runRoomSample(ctx, s, col, obs) {
  const { browser, canary, embed } = ctx;
  const { code, key, deckBase } = await embed.openRoom(s);
  const entry = `${deckBase}index.html`;
  const targets = {
    canaryHttp: canary.httpOrigin, canaryUdpPort: canary.udpPort, mainOrigin: ctx.mainOrigin,
    navTarget: embed.navTargetFor(s), mode: embed.name || "real",
  };
  const inject = injectTargets(targets);
  const presenter = await browser.openPage(`${s.id}-presenter`, embed.liveUrl(code, key), { inject });
  const participant = await browser.openPage(`${s.id}-participant`, embed.liveUrl(code), { inject });
  try {
    // 等 iframe 指向樣本 entry 並載入（有些攻擊會立刻把 iframe 導到 chrome-error，dataset 不一定讀得到；偵測靠 collector）
    await waitFor(async () => (await participant.eval(`(document.getElementById('deck')||{}).src || ''`).catch(() => "")).includes(deckBase), 8000);
    await waitFor(async () => (await participant.frameEval(entry, `document.body && document.body.dataset.t !== undefined`).catch(() => false)) === true, 8000);
    // M18：先對這個 browser context 授權所有可授權的權限，證明即使被授權，sandbox＋Permissions-Policy 仍擋得住
    if (s.id === "M18") {
      await browser.cdp("Browser.grantPermissions", { browserContextId: participant.browserContextId,
        permissions: ["geolocation", "audioCapture", "videoCapture", "notifications", "clipboardReadWrite", "displayCapture", "midi", "midiSysex"] }).catch(() => {});
      obs.granted = true;
    }
    await sleep(1200); // 讓非同步攻擊（fetch、權限、webrtc）有時間完成
    // 先讀一次 dataset（活化點擊可能觸發下載／導覽，使之後的 eval 卡住）
    obs.dataset = (await participant.frameEval(entry, `Object.assign({}, document.body.dataset)`).catch(() => null)) || {};

    // 需要使用者啟用的樣本：點擊 iframe 後再跑一次（跨通道事件由 collector 擷取，不靠 dataset；每步都設短逾時避免卡住）
    if (["M3", "M4", "M12", "M18", "M5"].includes(s.id)) {
      const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
      await cap(participant.clickInto().catch(() => {}), 5000);
      await sleep(900);
      const after = await cap(participant.frameEval(entry, `Object.assign({}, document.body.dataset)`).catch(() => null), 5000);
      if (after) obs.dataset = after;
    }

    if (s.id === "M10") {
      obs.main = await participant.eval(`({ pwned: !!window.__pwned, ready: (document.getElementById('deck')||{}).dataset?.ready || '', imgs: document.querySelectorAll('img').length, bodyText: document.body.innerText.slice(0, 4000) })`);
    }
    if (s.id === "M11") {
      // 翻頁測試：講師按下一頁，研習者是否跟上（翻頁同步經由 WebSocket，故翻頁成功＝WebSocket 維持）
      const before = await participant.eval(`(document.getElementById('pageInfo')||{}).textContent || ''`).catch(() => "");
      await presenter.eval(`(document.getElementById('next')||{}).click?.(); true`).catch(() => {});
      const advanced = await waitFor(async () => {
        const now = await participant.eval(`(document.getElementById('pageInfo')||{}).textContent || ''`).catch(() => "");
        return !!now && now !== before;
      }, 8000);
      obs.m11 = { pageAdvanced: advanced, wsAlive: advanced };
    }
    if (s.id === "M13") {
      const svgUrl = `${deckBase}evil.svg`;
      const svgPage = await browser.openPage(`${s.id}-svg-top`, svgUrl, { inject });
      await waitFor(async () => (await svgPage.eval(`document.readyState`)) === "complete", 8000);
      await sleep(900);
      obs.svg = await svgPage.eval(`window.__m13 || null`).catch(() => null);
      obs.svgTopUrl = await svgPage.eval(`location.href`).catch(() => "");
      await svgPage.close();
    }
  } finally {
    await participant.close(); await presenter.close();
  }
}

// embedpage 模式（對照組 B）：呼叫方提供嵌入頁；樣本在其 iframe 執行。
// 無 sandbox 時攻擊可能立刻把頂層導走或開窗，使頁面消失，因此一切讀取都是 best-effort；跨通道事件靠 collector。
async function runEmbedSample(ctx, s, col, obs) {
  const { browser, embed } = ctx;
  const { page, framePrefix } = await embed.openEmbed(s);
  try {
    await waitFor(async () => (await page.frameEval(framePrefix, `document.body && document.body.dataset.t !== undefined`).catch(() => false)) === true, 6000);
    await sleep(1200);
    obs.dataset = (await page.frameEval(framePrefix, `Object.assign({}, document.body.dataset)`).catch(() => null)) || {};
    if (["M3", "M4", "M12", "M18", "M5"].includes(s.id)) {
      const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
      await cap(page.clickInto().catch(() => {}), 5000);
      await sleep(900);
      const after = await cap(page.frameEval(framePrefix, `Object.assign({}, document.body.dataset)`).catch(() => null), 5000);
      if (after) obs.dataset = after;
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 直接執行：真實 stack 的正式測試 ----------
async function main() {
  const SHOTS = join(root, ".wrangler", "e2e-malicious-shots");
  mkdirSync(SHOTS, { recursive: true });
  const canary = await startCanary({ httpPort: CANARY_HTTP_PORT, udpPort: CANARY_UDP_PORT });
  const stack = await startStack({ tag: "e2e-malicious", mainPort: MAIN_PORT, deckPort: DECK_PORT });
  console.log(`收件端：HTTP ${canary.httpOrigin}、UDP 127.0.0.1:${canary.udpPort}`);
  console.log(`實例：主站 ${stack.mainBase}（PID ${stack.pids[0]}）、簡報主機 ${stack.deckBase}（PID ${stack.pids[1]}，MAIN_ORIGIN=${stack.mainOrigin}）`);
  const profile = mkdtempSync(join(tmpdir(), "ptt-mal-"));
  let chrome = null, browser = null;
  try {
    const M = stack.mainBase, D = stack.deckBase, L = stack.mainLocal;
    const A = await adminLogin(M);
    // 預先上傳每個樣本（真實三步 API），建立 uploadId → room 的對應（建場延後到各樣本執行時）
    const uploaded = new Map();
    for (const s of SAMPLES) {
      const up = await uploadDeckDir(M, A, join(FIXTURES, s.dir));
      uploaded.set(s.id, up);
    }
    console.log(`已上傳 ${uploaded.size} 個樣本（真實三步 API，全部通過伺服器驗證）`);

    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "--disable-background-networking", "--disable-component-update",
      "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    let ver;
    for (let i = 0; i < 60 && !ver; i++) { await sleep(250); try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch {} }
    if (!ver) throw new Error("Chrome 未啟動");
    console.log(`Chrome：${ver.Browser}（PID ${chrome.pid}，除錯埠 ${CDP_PORT}）`);
    browser = await createBrowser(ver.webSocketDebuggerUrl);
    // 下載行為：允許並發事件，下載到暫存（才攔得到 downloadWillBegin）
    const dlDir = join(SHOTS, "downloads"); mkdirSync(dlDir, { recursive: true });
    await browser.cdp("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });

    const embed = {
      mode: "room", name: "real",
      liveUrl: (code, key) => key ? `${L}/live?code=${code}#key=${encodeURIComponent(key)}` : `${L}/live?code=${code}`,
      openRoom: async (s) => {
        const up = uploaded.get(s.id);
        const room = (await createRoom(M, A, { deckId: up.id, version: up.version })).data;
        if (!room?.code || !room?.key) throw new Error(`建場失敗：${JSON.stringify(room)}`);
        return { code: room.code, key: room.key, deckBase: `${D}/${up.uploadId}/` };
      },
      // 真實測試：M16 的目標是收件端與主站網址（都應被 frame-src 擋下）；收件端命中片段 /nav-m16
      navTargetFor: () => `${canary.httpOrigin}/nav-m16`,
      navHitFrag: "/nav-m16",
    };
    const results = await runSuite({ browser, deckOrigin: D, mainOrigin: stack.mainOrigin, mainLocal: stack.mainLocal, canary, embed, samples: SAMPLES,
      browserName: ver.Browser, platform: `${process.platform} ${process.arch}` });

    // ---- 輸出 ----
    let failed = 0;
    console.log("\n================ M1–M18 結果 ================");
    for (const r of results) {
      const blockOk = r.kind === "block" ? r.succeeded === false : true;
      if (r.kind === "block" && r.succeeded) failed++;
      const actual = r.kind === "measure" ? (r.sent ? "有送出（量測）" : "未送出（量測）") : (r.succeeded ? "攻擊成功（未被擋）" : "被擋下");
      const tag = r.kind === "block" ? (r.succeeded ? "FAIL" : "PASS") : "MEAS";
      console.log(`\n[${tag}] ${r.id}｜${r.detector}`);
      console.log(`  攻擊：${r.title}`);
      console.log(`  預期：${r.expected}`);
      console.log(`  實際：${actual}`);
      console.log(`  證據：${r.evidence}`);
      if (r.conclusion) console.log(`  結論：${r.conclusion}`);
    }
    const measured = results.filter((r) => r.kind === "measure");
    console.log("\n================ 量測型結論（M11／M14／M15）================");
    for (const r of measured) console.log(`  ${r.id} ${r.detector}：${r.conclusion}`);
    console.log(failed ? `\n${failed} 個必擋樣本未被擋下（P0／P1）` : `\n全部必擋樣本都被擋下；量測型已記錄結論`);
    canary.stop();
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (browser) browser.close();
    if (chrome?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
    stack.stop();
    try { canary.stop(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log("FATAL  " + (e?.stack || e)); process.exit(1); });
}
