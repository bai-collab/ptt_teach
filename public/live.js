// 研習互動版主頁：連線、跟隨／自由觀看、翻頁同步、討論板（留言／投票／筆跡）
// 頁面結構（頁數、討論頁內容）來自 init 訊息的 deck 快照（S3b-3）。
// 簡報（S3d-B）：由獨立 origin 的簡報主機以 sandbox="allow-scripts" iframe 載入，網址來自 GET /api/rooms/:code；
// 動畫時間同步只透過契約 §3 的 postMessage（ready／seek／error），主站送出的訊息只含 ptt、type、t。
'use strict';
const $ = (id) => document.getElementById(id);

// ===== 頁面結構：全部來自場次 init 訊息的 deck 快照（契約欄位已由伺服器驗證）=====
// deck 的字串一律當純文字：只經 textContent／文字節點進入畫面，顏色只以 style 屬性賦值（#RRGGBB 先驗）。
// type：anim（動畫段）、html（簡報內的整頁 HTML）、disc（討論頁，kind 是板子類型 vote／wall／map／cols）
let PAGES = [];
const HEX = /^#[0-9a-fA-F]{6}$/;
const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x)) : []);
// 簡報包內的相對路徑（與伺服器 src/deck.js 相同的白名單；伺服器已驗證，這裡再擋一次才拼進網址）
const REL_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const safeRel = (v) => typeof v === 'string' && v.length <= 200 && REL_PATH.test(v) && !v.includes('..') && !/(^|\/)\.(\/|$)/.test(v);
// 動畫分段：依 deck.json segments 推導每段起點 a 與長度 len（秒）；不合格回空陣列（不送任何 seek）
let SEGS = [];
let ENTRY = null;
function buildSegs(d) {
  const out = [];
  let a = 0;
  if (!d || d.runtime !== 'timeline' || !Array.isArray(d.segments)) return out;
  for (const sg of d.segments) {
    const len = Number(sg && sg.duration);
    if (!Number.isFinite(len) || len <= 0) return [];
    out.push({ a, len });
    a += len;
  }
  return out;
}
function buildPages(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.pages) || !d.pages.length || d.pages.length > 100) return null;
  const segs = Array.isArray(d.segments) ? d.segments : [];
  try {
    // hasText：deck 頁面有 text 才開放 S8 單頁 AI 問答（文字本身不進畫面，伺服器另取快照）
    const withText = (p, o) => ({ ...o, hasText: typeof p.text === 'string' && p.text.trim().length > 0 });
    return d.pages.map((p) => withText(p, (() => {
      if (p.type === 'anim') {
        const sg = segs[p.seg];
        return { type: 'anim', seg: p.seg, title: sg ? `${sg.group}・${sg.title}` : `動畫 ${Number(p.seg) + 1}` };
      }
      if (p.type === 'html') return { type: 'html', title: String(p.title), path: safeRel(p.path) ? p.path : null };
      if (p.type === 'disc' && ['vote', 'wall', 'map', 'cols'].includes(p.kind)) {
        return {
          type: 'disc', kind: p.kind, kicker: String(p.kicker), title: String(p.title), prompt: String(p.prompt),
          options: strs(p.options), nodes: strs(p.nodes), cols: strs(p.columns),
          tags: Array.isArray(p.tags) ? p.tags.map((t) => ({ label: String(t.label), color: HEX.test(t.color) ? t.color : '#cccccc' })) : [],
        };
      }
      throw new Error('bad page');
    })()));
  } catch { return null; }
}
const COLORS = ['#efe9d8', '#f2c14e', '#e8875b', '#7fb6d9', '#8fd18a'];

// ===== 身分與參數 =====
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
if (!/^[A-Z0-9]{6}$/.test(code)) location.replace('/');
const key = new URLSearchParams(location.hash.slice(1)).get('key') || '';
function makeId() {
  const r = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...r)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
let pid = localStorage.getItem('aee.pid');
if (!pid || !/^[A-Za-z0-9_-]{8,40}$/.test(pid)) { pid = makeId(); localStorage.setItem('aee.pid', pid); }
const myName = localStorage.getItem('aee.name') || (key ? '講師' : '');
$('code').textContent = code;

// ===== 狀態 =====
let me = { pid, role: 'participant', name: myName };
let mode = 'follow'; // follow | free（講師不使用）
let pres = { page: 0, t: 0, playing: false, offset: 0, recv: performance.now() };
const view = { page: 0, t: 0, playing: false }; // 自己的播放狀態（講師與自由觀看使用）
let renderedPage = -1;
const notes = new Map(), strokes = new Map(), pending = new Map(), labels = new Map();
let votes = {}, myVotes = {}, voters = {}, showAuthors = false;
let ended = false, inited = false;

// ===== 簡報 iframe（簡報主機；契約 §3 主站端規則）=====
const deck = $('deck');
const deckHold = $('deckHold');
let deckBase = null; // 例：http://127.0.0.1:8802/<uploadId>/（伺服器以 upload_id 組成；沒有就不載入）
let deckInfoDone = false;
let deckSrc = 'about:blank'; // 目前 iframe 指向的網址（只由本檔設定）
let deckReady = false; // 這次載入是否已收到（第一則）ready
let loadsSinceNav = 0; // 本檔設定 src 之後的 load 次數：第 2 次起代表簡報自行換頁，需要新的 ready
let lastSeekT = -1, lastSeekAt = 0;
const BASE_RE = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/[0-9a-f]{32}\/$/;
async function loadDeckInfo() {
  try {
    const r = await fetch(`/api/rooms/${code}`, { cache: 'no-store' });
    const d = await r.json();
    deckBase = d && typeof d.deckBase === 'string' && BASE_RE.test(d.deckBase) ? d.deckBase : null;
  } catch { deckBase = null; }
  deckInfoDone = true;
  renderedPage = -1; // 重畫，套用簡報網址
}
// 依頁面決定 iframe 網址：anim → entry?embed=1；html → 該頁路徑；其他 → about:blank
function deckTarget(pg) {
  if (!deckBase || !pg) return 'about:blank';
  if (pg.type === 'anim' && ENTRY) return deckBase + ENTRY + '?embed=1';
  if (pg.type === 'html' && pg.path) return deckBase + pg.path;
  return 'about:blank';
}
function setDeckSrc(target) {
  if (target === deckSrc) return;
  deckSrc = target;
  deckReady = false; loadsSinceNav = 0; lastSeekT = -1;
  deck.dataset.ready = '0';
  deck.src = target;
}
// 規則 5：每次載入都重設狀態。本檔換網址時已重設；之後若再有 load（簡報自行換頁）就重設並等待新的 ready。
// （本檔換網址後的第 1 次 load 不重設：簡報可能在 load 事件之前就送出 ready）
deck.addEventListener('load', () => {
  loadsSinceNav++;
  if (loadsSinceNav > 1) { deckReady = false; lastSeekT = -1; deck.dataset.ready = '0'; }
});
// 規則 1～4：只收本 iframe 的訊息（不透明 origin，不能用 event.origin）；先檢查格式；ready 每次載入只收第一則；
// error 的 code 只記錄、不顯示；簡報傳來的字串一律不進畫面
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
addEventListener('message', (e) => {
  if (!deck.contentWindow || e.source !== deck.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.ptt !== 1) return;
  if (m.type === 'ready') {
    if (deckReady || !deckBase || !deckSrc.startsWith(deckBase)) return;
    if (!isNum(m.duration) || m.duration < 0 || m.duration > 7200) return;
    deckReady = true; lastSeekT = -1;
    deck.dataset.ready = '1';
    const total = SEGS.length ? SEGS[SEGS.length - 1].a + SEGS[SEGS.length - 1].len : 0;
    if (SEGS.length && Math.abs(m.duration - total) > 0.5 && me.role === 'presenter') toast('簡報回報的長度與 deck.json 不同，以 deck.json 為準');
  } else if (m.type === 'error') {
    if (typeof m.code !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(m.code)) return;
    console.warn('簡報回報錯誤代碼', m.code);
  }
});
// 主站→簡報：targetOrigin 只能用 "*"（不透明 origin），所以訊息只含公開的時間資料
function postSeek(t) {
  try { deck.contentWindow.postMessage({ ptt: 1, type: 'seek', t }, '*'); } catch { /* iframe 已換頁 */ }
}
const segOf = (p) => (PAGES[p] && PAGES[p].type === 'anim' ? SEGS[PAGES[p].seg] || null : null);
function pageTitle(p) {
  const pg = PAGES[p];
  return pg.type === 'disc' ? pg.kicker : pg.title;
}

// ===== 連線 =====
let ws = null, backoff = 500, pingTimer = null;
function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${code}/ws`;
  ws = new WebSocket(url);
  setConn('連線中…', '');
  ws.onopen = () => {
    backoff = 500;
    ws.send(JSON.stringify({ type: 'hello', pid, name: myName, key: key || undefined }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 25000);
  };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (ended) return;
    setConn('連線中斷，重新連線…', 'bad');
    setTimeout(connect, backoff + Math.random() * 300);
    backoff = Math.min(backoff * 2, 8000);
  };
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function setConn(text, cls) { const c = $('conn'); c.textContent = text; c.className = 'conn ' + cls; }
['online', 'pageshow'].forEach((ev) => addEventListener(ev, () => { if (!ended && ws && ws.readyState > 1) { backoff = 500; connect(); } }));

function setPres(p, serverNow) {
  pres = { ...p, offset: Math.max(0, (serverNow - p.at) / 1000), recv: performance.now() };
}
function onMessage(m) {
  switch (m.type) {
    case 'init': {
      me = m.me;
      PAGES = buildPages(m.deck) || []; // deck 為 null 或不合格：進入「簡報資料無法載入」狀態
      SEGS = PAGES.length ? buildSegs(m.deck) : [];
      ENTRY = PAGES.length && safeRel(m.deck.entry) ? m.deck.entry : null;
      setPres(m.pres, m.now);
      notes.clear(); m.notes.forEach((n) => notes.set(n.id, n));
      strokes.clear(); m.strokes.forEach((s) => strokes.set(s.id, s));
      labels.clear(); (m.labels || []).forEach((l) => labels.set(l.id, l));
      votes = m.votes; myVotes = m.myVotes; voters = m.voters || {};
      $('people').textContent = `在線 ${m.count} 人`;
      setConn('已連線', 'ok');
      if (!inited) {
        inited = true;
        if (me.role === 'presenter') { view.page = m.pres.page; view.t = 0; view.playing = false; }
        setupRole();
      }
      reportState(); // 每次（重新）連線都回報，伺服器端的狀態跟著連線重設
      renderedPage = -1; // 重畫
      break;
    }
    case 'pres': setPres(m.pres, m.now); updateFollowHint(); break;
    case 'presence': $('people').textContent = `在線 ${m.count} 人`; break;
    case 'roster': lastRoster = m.people; renderRoster(); break;
    case 'note': notes.set(m.note.id, m.note); refreshBoard(m.note.page); break;
    case 'note.del': { const n = notes.get(m.id); notes.delete(m.id); if (n) refreshBoard(n.page); break; }
    case 'note.pin': { const n = notes.get(m.id); if (n) { n.pinned = m.pinned; refreshBoard(n.page); } break; }
    case 'votes': votes[m.page] = m.counts; if (m.reset) delete myVotes[m.page]; refreshBoard(m.page); break;
    case 'myvote': myVotes[m.page] = m.opt; refreshBoard(m.page); break;
    case 'voters': voters[m.page] = m.voters; refreshBoard(m.page); break;
    case 'stroke': if (m.cid) pending.delete(m.cid); strokes.set(m.stroke.id, m.stroke); if (m.stroke.page === curPage()) drawInk(); break;
    case 'stroke.del': strokes.delete(m.id); drawInk(); break;
    case 'stroke.clear':
      for (const [id, s] of strokes) if (s.page === m.page) strokes.delete(id);
      for (const [id, l] of labels) if (l.page === m.page) labels.delete(id);
      drawInk(); renderLabels(); break;
    case 'label': labels.set(m.label.id, m.label); if (m.label.page === curPage()) renderLabels(); break;
    case 'label.del': labels.delete(m.id); renderLabels(); break;
    case 'error': toast(m.message); break;
    case 'ended': ended = true; showOverlay('本場研習已結束，留言與筆跡已刪除。'); try { ws.close(); } catch {} break;
  }
}

// ===== 角色介面 =====
function setupRole() {
  const isP = me.role === 'presenter';
  $('roleTag').hidden = !isP;
  $('copyJoin').hidden = !isP;
  $('endBtn').hidden = !isP;
  $('followBtn').hidden = isP;
  $('clearBtn').hidden = !isP;
  $('textBtn').hidden = !isP;
  $('rosterBtn').hidden = !isP;
  $('authorBtn').hidden = !isP;
}

// ===== 講師專用：研習者名單 =====
let lastRoster = [];
function renderRoster() {
  if (me.role !== 'presenter') return;
  const free = lastRoster.filter((p) => p.mode === 'free');
  $('rosterBtn').textContent = `跟隨 ${lastRoster.length - free.length}・自由 ${free.length}`;
  const sorted = [...lastRoster].sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name, 'zh-Hant') : a.mode === 'free' ? -1 : 1));
  const items = sorted.map((p) => {
    let label, cls;
    if (p.mode === 'follow') { label = '跟隨中'; cls = 'follow'; }
    else if (p.page === view.page) { label = '自由・同一頁'; cls = 'free'; }
    else { label = p.page == null ? '自由觀看' : `自由・第 ${p.page + 1} 頁`; cls = 'free away'; }
    return el('li', {}, el('span', { class: 'who' }, p.name), el('span', { class: 'tag ' + cls }, label));
  });
  $('rosterList').replaceChildren(...(items.length ? items : [el('li', { class: 'empty-li' }, '目前沒有研習者')]));
}
$('rosterBtn').onclick = () => {
  const open = $('roster').hidden;
  $('roster').hidden = !open;
  $('rosterBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
};
$('copyJoin').onclick = async () => {
  const link = `${location.origin}/?code=${code}`;
  try { await navigator.clipboard.writeText(link); toast('已複製加入連結'); } catch { prompt('加入連結', link); }
};
$('endBtn').onclick = () => {
  if (confirm('確定要結束本場並刪除所有留言、投票與筆跡嗎？這個動作無法復原。')) send({ type: 'room.end' });
};
$('followBtn').onclick = () => setMode(mode === 'follow' ? 'free' : 'follow');
// 研習者回報自己的狀態（講師用來看誰在跟隨、誰在自由觀看）
function reportState() {
  if (me.role === 'presenter') return;
  send({ type: 'state', mode, page: mode === 'free' ? view.page : null });
}
function setMode(m) {
  mode = m;
  const b = $('followBtn');
  b.setAttribute('aria-pressed', m === 'follow' ? 'true' : 'false');
  b.textContent = m === 'follow' ? '跟隨講師中' : '回到講師頁面';
  if (m === 'free') { const c = current(); view.page = c.page; view.t = c.t; view.playing = c.playing; }
  updateFollowHint();
  reportState();
}
function updateFollowHint() {
  const h = $('followHint');
  if (me.role === 'presenter') { h.textContent = '你的翻頁與播放會同步給跟隨中的研習者'; return; }
  h.textContent = mode === 'follow' ? '正在跟隨講師' : `講師目前在第 ${pres.page + 1} 頁`;
}

// ===== 播放時間軸 =====
function current() {
  if (me.role !== 'presenter' && mode === 'follow') {
    const t = pres.t + (pres.playing ? pres.offset + (performance.now() - pres.recv) / 1000 : 0);
    return { page: pres.page, t, playing: pres.playing };
  }
  return view;
}
const curPage = () => current().page;
function broadcastPres() { if (me.role === 'presenter') send({ type: 'pres', page: view.page, t: view.t, playing: view.playing }); }
function go(page) {
  if (!PAGES.length) return;
  page = Math.max(0, Math.min(PAGES.length - 1, page));
  if (me.role !== 'presenter' && mode === 'follow') { setMode('free'); toast('已切換為自由觀看，可按「回到講師頁面」'); }
  view.page = page; view.t = 0; view.playing = !!segOf(page); // 動畫頁翻到就開始播放
  broadcastPres();
  reportState();
}
function togglePlay() {
  if (me.role !== 'presenter' && mode === 'follow') setMode('free');
  const s = segOf(view.page);
  if (!s) return;
  if (!view.playing && view.t >= s.len - 0.5) view.t = 0;
  view.playing = !view.playing;
  broadcastPres();
}
$('prev').onclick = () => go(current().page - 1);
$('next').onclick = () => go(current().page + 1);
$('play').onclick = togglePlay;
addEventListener('keydown', (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); go(current().page + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(current().page - 1); }
  else if (e.key === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
});

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.max(0, (now - lastFrame) / 1000); lastFrame = now;
  // 自己的時鐘（講師／自由觀看）
  const s0 = segOf(view.page);
  if (view.playing && s0) {
    view.t += dt;
    if (view.t >= s0.len - 0.45) { view.t = Math.max(0, s0.len - 0.45); view.playing = false; broadcastPres(); }
  }
  const c = current();
  if (c.page !== renderedPage) renderPage(c.page);
  // 時間同步：ready 之後才送 seek；時間有變就送，暫停時每 0.4 秒重送一次（簡報端冪等）
  const s = segOf(c.page);
  if (s && deckReady) {
    const t = Math.min(Math.max(c.t, 0), Math.max(0, s.len - 0.45));
    if (Math.abs(t - lastSeekT) > 0.001 || now - lastSeekAt > 400) { postSeek(s.a + t); lastSeekT = t; lastSeekAt = now; }
  }
  $('play').textContent = c.playing ? '暫停' : '播放';
  requestAnimationFrame(frame);
}

// 簡報資料不可用（尚未收到 init、deck 為 null 或頁碼超出）：安全的空狀態，翻頁一律停用
function renderUnavailable() {
  $('disc').hidden = true;
  setDeckSrc('about:blank');
  deck.style.visibility = 'visible';
  deckHold.hidden = false;
  deckHold.textContent = '簡報資料無法載入';
  $('tools').hidden = true;
  $('composer').hidden = true;
  $('toolSep').hidden = true;
  setTool(null);
  $('prev').disabled = $('next').disabled = $('play').disabled = true;
  $('pageInfo').textContent = '簡報資料無法載入';
  $('resetVote').hidden = true;
  $('askBtn').hidden = true; setAskOpen(false);
  drawInk(); renderLabels(); fitMarks();
  updateFollowHint();
  renderRoster();
}
function renderPage(p) {
  renderedPage = p;
  const pg = PAGES[p];
  if (!pg) { renderUnavailable(); return; }
  $('prev').disabled = $('next').disabled = false;
  lastSeekT = -1;
  const isDisc = pg.type === 'disc';
  // 討論頁保留目前的 iframe（不重新載入），只隱藏
  if (!isDisc) setDeckSrc(deckTarget(pg));
  const noFile = !isDisc && deckSrc === 'about:blank';
  deckHold.textContent = deckInfoDone ? '此場次沒有可載入的簡報檔案' : '簡報載入中…';
  $('disc').hidden = !isDisc;
  deck.style.visibility = isDisc ? 'hidden' : 'visible';
  deckHold.hidden = !noFile;
  // 工具列：討論頁所有人都有；講師在動畫頁也有（只有標註工具，沒有留言欄）
  $('tools').hidden = !(isDisc || me.role === 'presenter');
  $('composer').hidden = !isDisc;
  $('toolSep').hidden = !isDisc;
  if (!canAnnotate(p)) setTool(null);
  $('play').disabled = !segOf(p);
  $('pageInfo').textContent = `${p + 1} / ${PAGES.length}・${pageTitle(p)}`;
  updateAsk(p);
  if (isDisc) { setupComposer(pg); refreshBoard(p, true); fitBoard(); }
  drawInk(); renderLabels(); fitMarks();
  updateFollowHint();
  renderRoster();
}

// ===== 討論板 =====
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
// 以 style 屬性賦值上色（deck 驗證過的 #RRGGBB），不拼接 HTML 或 cssText
function colored(e, color) { e.style.background = color; return e; }
function noteEl(n, pg) {
  const mine = n.pid === me.pid, isP = me.role === 'presenter';
  const tg = pg.kind === 'map' && n.tag2 != null ? pg.tags[n.tag2] : null;
  const chip = tg ? colored(el('span', { class: 'chip' }, tg.label), tg.color) : null;
  const meta = el('div', { class: 'meta' }, el('span', { class: 'who' }, n.name + (n.pinned ? '・講師置頂' : '')));
  if (isP) meta.append(el('button', { type: 'button', onclick: () => send({ type: 'note.pin', id: n.id, pinned: !n.pinned }) }, n.pinned ? '取消置頂' : '置頂'));
  if (mine || isP) meta.append(el('button', { type: 'button', onclick: () => { if (confirm('刪除這則留言？')) send({ type: 'note.del', id: n.id }); } }, '刪除'));
  return el('div', { class: 'note' + (n.pinned ? ' pinned' : '') }, el('div', {}, chip, n.text), meta);
}
function pageNotes(p) {
  return [...notes.values()].filter((n) => n.page === p).sort((a, b) => (b.pinned - a.pinned) || (a.ts - b.ts));
}
function notesList(list, pg, emptyText) {
  const box = el('div', { class: 'scroll' });
  if (!list.length) box.append(el('div', { class: 'empty' }, emptyText));
  list.forEach((n) => box.append(noteEl(n, pg)));
  return box;
}
function refreshBoard(p, force) {
  if (p !== curPage() && !force) return;
  const pg = PAGES[p];
  if (!pg || pg.type !== 'disc') return;
  // 保留捲動位置
  const scrolls = [...$('board').querySelectorAll('.scroll')].map((s) => s.scrollTop);
  const head = el('div', { class: 'b-head' }, el('div', { class: 'b-kicker' }, pg.kicker), el('div', { class: 'b-title' }, pg.title), el('div', { class: 'b-prompt' }, pg.prompt));
  const body = el('div', { class: 'b-body' });
  const list = pageNotes(p);
  if (pg.kind === 'vote') {
    const counts = votes[p] || pg.options.map(() => 0);
    const total = counts.reduce((a, b) => a + b, 0), max = Math.max(1, ...counts);
    const isP = me.role === 'presenter';
    const opts = el('div', { class: 'scroll' });
    pg.options.forEach((o, i) => {
      opts.append(el('button', { type: 'button', class: 'opt' + (myVotes[p] === i ? ' mine' : ''), onclick: () => send({ type: 'vote', page: p, opt: i }) },
        el('span', { class: 'bar-fill', style: `width:${(counts[i] / max) * 100}%` }),
        el('span', { class: 'label' }, o), el('span', { class: 'cnt' }, counts[i])));
      const names = (voters[p] && voters[p][i]) || [];
      if (isP && names.length) opts.append(el('div', { class: 'voters' }, names.join('、')));
    });
    const left = el('div', { class: 'b-col', style: 'flex:0 0 740px' }, el('h3', {}, isP ? '投票（講師看得到投票者）' : '投票（可改選）'), opts,
      el('div', { class: 'vote-total' }, `共 ${total} 票`));
    body.append(left, el('div', { class: 'b-col', style: 'flex:1' }, el('h3', {}, '補充想法'), notesList(list, pg, '還沒有留言，寫下你選它的理由吧。')));
  } else if (pg.kind === 'wall') {
    const box = notesList(list, pg, '還沒有留言，成為第一個分享的人。');
    box.classList.add('wall');
    body.append(el('div', { class: 'b-col', style: 'flex:1' }, box));
  } else if (pg.kind === 'map') {
    const wrap = el('div', { class: 'b-col', style: 'flex:1' });
    wrap.append(el('div', { class: 'legend' }, '阻塞類型：', pg.tags.map((b) => {
      const c = colored(el('span', { class: 'chip' }, b.label), b.color);
      c.style.color = '#1a2b23'; c.style.borderRadius = '6px'; c.style.padding = '0 8px';
      return c;
    })));
    const ncol = Math.max(1, Math.min(4, pg.nodes.length)), nrow = Math.max(1, Math.ceil(pg.nodes.length / ncol));
    const grid = el('div', { style: `display:grid;grid-template-columns:repeat(${ncol},1fr);grid-template-rows:repeat(${nrow},1fr);gap:14px;flex:1;min-height:0` });
    pg.nodes.forEach((name, i) => {
      const ns = list.filter((n) => n.tag === i);
      grid.append(el('div', { class: 'node' }, el('h4', {}, `${name}（${ns.length}）`), notesList(ns, pg, '尚無')));
    });
    wrap.append(grid); body.append(wrap);
  } else if (pg.kind === 'cols') {
    pg.cols.forEach((c, i) => {
      body.append(el('div', { class: 'b-col node', style: 'flex:1' }, el('h4', {}, c), notesList(list.filter((n) => n.tag === i), pg, '尚無')));
    });
  }
  $('board').replaceChildren(head, body);
  [...$('board').querySelectorAll('.scroll')].forEach((s, i) => { if (scrolls[i]) s.scrollTop = scrolls[i]; });
  $('resetVote').hidden = !(me.role === 'presenter' && pg.kind === 'vote');
}
$('resetVote').onclick = () => { if (confirm('清空本頁所有投票？')) send({ type: 'vote.reset', page: curPage() }); };

// ===== 留言輸入列 =====
function fillSelect(sel, label, items) {
  sel.replaceChildren(el('option', { value: '' }, label), ...items.map((t, i) => el('option', { value: i }, t)));
  sel.hidden = false;
}
function setupComposer(pg) {
  $('sel1').hidden = $('sel2').hidden = true;
  if (pg.kind === 'map') { fillSelect($('sel1'), '選節點', pg.nodes); fillSelect($('sel2'), '阻塞類型', pg.tags.map((b) => b.label)); }
  if (pg.kind === 'cols') fillSelect($('sel1'), '放到哪一格', pg.cols);
  $('text').placeholder = pg.kind === 'vote' ? '補充你的理由（可選，最多 100 字）' : pg.kind === 'map' ? '寫一件高頻工作或卡住的地方' : '寫下你的想法（最多 100 字）';
}
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = curPage(), pg = PAGES[p];
  const text = $('text').value.trim();
  if (!pg || !text) return;
  const msg = { type: 'note.add', page: p, text };
  if (pg.kind === 'map') {
    if ($('sel1').value === '' || $('sel2').value === '') { toast('請先選節點與阻塞類型'); return; }
    msg.tag = +$('sel1').value; msg.tag2 = +$('sel2').value;
  }
  if (pg.kind === 'cols') {
    if ($('sel1').value === '') { toast('請選要放到哪一格'); return; }
    msg.tag = +$('sel1').value;
  }
  send(msg);
  $('text').value = '';
});

// ===== 縮放：討論板以 1600×900 排版後整體縮放到舞台大小 =====
function fitBoard() {
  const d = $('disc');
  const w = d.clientWidth, h = d.clientHeight;
  $('scaler').style.transform = `scale(${Math.min(w / 1600, h / 900)})`;
}
new ResizeObserver(fitBoard).observe($('disc'));

// ===== 標註層：筆跡（講師任何頁；學員只在討論頁）＋講師文字標註 =====
const ink = $('ink'), ictx = ink.getContext('2d');
let tool = null, penColor = COLORS[1], drawing = null, labelAt = null;
const canAnnotate = (p) => !!PAGES[p] && (PAGES[p].type === 'disc' || me.role === 'presenter');
COLORS.forEach((c, i) => {
  const b = el('button', { type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `顏色 ${i + 1}`, 'aria-pressed': c === penColor ? 'true' : 'false' });
  b.onclick = () => { penColor = c; document.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); if (!tool) setTool('pen'); };
  $('swatches').append(b);
});
function setTool(t) {
  tool = t;
  $('penBtn').setAttribute('aria-pressed', t === 'pen' ? 'true' : 'false');
  $('textBtn').setAttribute('aria-pressed', t === 'text' ? 'true' : 'false');
  ink.classList.toggle('on', !!t);
  ink.classList.toggle('text-mode', t === 'text');
  if (t !== 'text') closeLabelInput();
}
$('penBtn').onclick = () => setTool(tool === 'pen' ? null : 'pen');
$('textBtn').onclick = () => setTool(tool === 'text' ? null : 'text');
function drawStroke(s) {
  const p = s.pts;
  if (p.length < 4) return;
  ictx.strokeStyle = s.color; ictx.lineWidth = s.w; ictx.lineCap = 'round'; ictx.lineJoin = 'round';
  ictx.beginPath(); ictx.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) ictx.lineTo(p[i], p[i + 1]);
  ictx.stroke();
}
function drawAuthor(s) {
  if (!s.name) return;
  const x = Math.min(s.pts[0] + 8, 1500), y = Math.max(s.pts[1] - 12, 24);
  ictx.font = '600 18px "Noto Sans TC", sans-serif';
  const w = ictx.measureText(s.name).width + 14;
  ictx.fillStyle = 'rgba(26,43,35,.88)'; ictx.strokeStyle = s.color; ictx.lineWidth = 2;
  ictx.beginPath(); ictx.roundRect(x, y - 20, w, 28, 6); ictx.fill(); ictx.stroke();
  ictx.fillStyle = s.color; ictx.fillText(s.name, x + 7, y);
}
function drawInk() {
  ictx.setTransform(2, 0, 0, 2, 0, 0);
  ictx.clearRect(0, 0, 1600, 900);
  const p = curPage();
  for (const s of strokes.values()) if (s.page === p) drawStroke(s);
  for (const s of pending.values()) if (s.page === p) drawStroke(s);
  if (drawing) drawStroke(drawing);
  if (showAuthors && me.role === 'presenter') for (const s of strokes.values()) if (s.page === p) drawAuthor(s);
}
$('authorBtn').onclick = () => {
  showAuthors = !showAuthors;
  $('authorBtn').setAttribute('aria-pressed', showAuthors ? 'true' : 'false');
  drawInk();
};
function toLogical(e) {
  const r = ink.getBoundingClientRect();
  return [Math.round(((e.clientX - r.left) / r.width) * 1600), Math.round(((e.clientY - r.top) / r.height) * 900)];
}
ink.addEventListener('pointerdown', (e) => {
  if (!tool) return;
  e.preventDefault();
  if (tool === 'text') { const [x, y] = toLogical(e); openLabelInput(x, y); return; }
  ink.setPointerCapture(e.pointerId);
  drawing = { page: curPage(), color: penColor, w: 5, pts: toLogical(e) };
});
ink.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const [x, y] = toLogical(e), p = drawing.pts;
  if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < 3) return;
  if (p.length >= 800) return;
  p.push(Math.max(0, Math.min(1600, x)), Math.max(0, Math.min(900, y)));
  drawInk();
});
function endStroke() {
  if (!drawing) return;
  const s = drawing; drawing = null;
  if (s.pts.length === 2) s.pts.push(s.pts[0] + 1, s.pts[1] + 1); // 點一下也留下一個點
  const cid = makeId();
  pending.set(cid, s);
  send({ type: 'stroke', page: s.page, color: s.color, w: s.w, pts: s.pts, cid });
  setTimeout(() => { if (pending.delete(cid)) drawInk(); }, 8000); // 伺服器拒收時移除預覽
  drawInk();
}
ink.addEventListener('pointerup', endStroke);
ink.addEventListener('pointercancel', endStroke);
$('undoBtn').onclick = () => {
  const p = curPage();
  const mine = [...strokes.values()].filter((s) => s.page === p && s.pid === me.pid);
  if (mine.length) send({ type: 'stroke.del', id: mine[mine.length - 1].id });
};
$('clearBtn').onclick = () => { if (confirm('清除本頁所有筆跡與文字標註？')) send({ type: 'stroke.clear', page: curPage() }); };

// 講師文字標註：點畫面 → 輸入 → Enter 放上；講師可按 × 刪除
function renderLabels() {
  const p = curPage(), isP = me.role === 'presenter';
  $('labels').replaceChildren(...[...labels.values()].filter((l) => l.page === p).map((l) => {
    const d = el('div', { class: 'label', style: `left:${l.x}px;top:${l.y}px;color:${l.color};border-color:${l.color}` }, l.text);
    if (isP) d.append(el('button', { type: 'button', class: 'label-x', 'aria-label': '刪除這段文字', onclick: () => send({ type: 'label.del', id: l.id }) }, '×'));
    return d;
  }));
}
function openLabelInput(x, y) {
  labelAt = { x, y, page: curPage() };
  const inp = $('labelInput');
  inp.value = ''; inp.style.left = `${Math.min(x, 1600 - 540)}px`; inp.style.top = `${Math.max(30, Math.min(y, 870))}px`; inp.style.color = penColor;
  inp.hidden = false;
  setTimeout(() => inp.focus(), 0);
}
function closeLabelInput() { $('labelInput').hidden = true; labelAt = null; }
$('labelInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (text && labelAt) send({ type: 'label.add', page: labelAt.page, x: labelAt.x, y: labelAt.y, text, color: penColor });
    closeLabelInput();
  } else if (e.key === 'Escape') closeLabelInput();
});
$('labelInput').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('labelInput')) closeLabelInput(); }, 200));

// 標註層隨舞台縮放（舞台固定 16:9）
function fitMarks() { $('mscaler').style.transform = `scale(${$('stage').clientWidth / 1600})`; }
new ResizeObserver(fitMarks).observe($('stage'));

// ===== S8 單頁 AI 問答 =====
// 只在該頁 deck 有 text 時顯示按鈕；回答以 DOM 節點組成極簡 Markdown（段落、粗體、清單、行內程式碼），全程只用文字節點，不經 innerHTML。
let askPageIdx = -1, askBusy = false;
function updateAsk(p) {
  const pg = PAGES[p];
  const ok = !!(pg && pg.hasText);
  $('askBtn').hidden = !ok;
  if (p !== askPageIdx) { askPageIdx = p; $('askAnswer').replaceChildren(); }
  if (!ok) { setAskOpen(false); return; }
  $('askPage').textContent = `第 ${p + 1} 頁・${pageTitle(p)}`;
}
function setAskOpen(open) {
  $('askPanel').hidden = !open;
  $('askBtn').setAttribute('aria-expanded', String(open));
  if (open) setTimeout(() => $('askInput').focus(), 0);
}
// 行內：**粗體**、`程式碼`；其餘一律當純文字
function mdInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const e = document.createElement(m[1] !== undefined ? 'strong' : 'code');
    e.textContent = m[1] !== undefined ? m[1] : m[2];
    out.push(e);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
function mdRender(src) {
  const frag = document.createDocumentFragment();
  let list = null, para = [];
  const flush = () => { if (para.length) { const p = document.createElement('p'); p.append(...mdInline(para.join(' '))); frag.append(p); para = []; } };
  for (const raw of String(src).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const tag = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = document.createElement(tag); frag.append(list); }
      const item = document.createElement('li'); item.append(...mdInline(li[1])); list.append(item);
      continue;
    }
    list = null;
    if (!line) { flush(); continue; }
    para.push(line.replace(/^#{1,6}\s+/, ''));
  }
  flush();
  return frag;
}
$('askBtn').onclick = () => setAskOpen($('askPanel').hidden);
$('askClose').onclick = () => setAskOpen(false);
$('askInput').addEventListener('input', () => { $('askCount').textContent = `${[...$('askInput').value].length} / 300`; });
$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (askBusy) return;
  const question = $('askInput').value.trim();
  const page = curPage();
  if (!question) { toast('請先輸入問題'); return; }
  if (!PAGES[page] || !PAGES[page].hasText) return;
  askBusy = true; $('askSend').disabled = true;
  const box = $('askAnswer');
  const q = document.createElement('div'); q.className = 'ask-q'; q.textContent = `你問：${question}`;
  const wait = document.createElement('p'); wait.textContent = 'AI 思考中…';
  box.replaceChildren(q, wait);
  const fail = (text) => { const er = document.createElement('p'); er.className = 'ask-err'; er.textContent = text; box.replaceChildren(q, er); };
  try {
    const r = await fetch(`/api/rooms/${code}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, question, pid }) });
    let d = null; try { d = await r.json(); } catch { /* 非 JSON */ }
    if (askPageIdx !== page) return; // 已經換頁，丟棄舊回答
    if (r.ok && d && typeof d.answer === 'string') {
      box.replaceChildren(q, mdRender(d.answer));
      $('askInput').value = ''; $('askCount').textContent = '0 / 300';
    } else fail(d && typeof d.error === 'string' ? d.error : `提問失敗（${r.status}）`);
  } catch {
    if (askPageIdx === page) fail('連線失敗，請稍後再試');
  } finally { askBusy = false; $('askSend').disabled = false; }
});

// ===== 小工具 =====
let toastTimer = null;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function showOverlay(text) { $('overlayText').textContent = text; $('overlay').hidden = false; }

setMode('follow');
renderUnavailable(); // 收到 init 之前先顯示安全的空狀態
loadDeckInfo();
connect();
requestAnimationFrame(frame);
