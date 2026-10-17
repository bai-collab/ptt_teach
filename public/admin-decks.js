// 簡報庫管理（S3c-2）：管理者在講師入口選 deck.zip → 瀏覽器端解壓與預檢 → 逐檔算 SHA-256 → 三步上傳。
//
// 安全約束（管理者頁 XSS；主站 CSP 允許 'unsafe-inline'，任何 HTML 注入都等於管理者身分下的 XSS）：
// - 不預覽、不渲染任何 zip 內容；zip 內的檔案只被當成位元組計數、雜湊與上傳。
// - 路徑、大小、預檢結果、伺服器錯誤（含 path 欄位）一律以文字節點顯示：沿用 teacher.html 的 el()，
//   另以 shown() 把控制字元與雙向文字覆寫字元換成可見的「⟨U+XXXX⟩」，並截斷超長字串。
// - 本檔不使用任何會解析 HTML 字串或開新視窗的 API（審查以 grep 確認）。
// - 瀏覽器端的解壓與預檢只為使用體驗，不是安全邊界；伺服器（src/deck-upload.js、src/catalog.js）會重新檢查全部規則。
(() => {
  'use strict';
  if (typeof el !== 'function') return; // 依賴 teacher.html 的 el()

  // ---- 與伺服器相同的規則（src/deck-upload.js 的 UPLOAD_LIMITS、checkManifestPath、validateManifest）----
  const KiB = 1024, MiB = 1024 * 1024;
  const LIM = Object.freeze({
    bodyBytes: 512 * KiB,
    deckBytes: 128 * KiB,
    filesMax: 300,
    fileBytesMax: 10 * MiB,
    totalBytesMax: 60 * MiB,
    pathLen: 200,
    pathDepth: 8,
    // 只在瀏覽器端：zip 本身的上限
    zipBytesMax: 80 * MiB,
    zipEntriesMax: 1000,
  });
  const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
  const DOT_SEGMENT_RE = /(?:^|\/)\.(?:\/|$)/;
  const DECK_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
  const DECK_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
  const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;
  const EXTS = new Set(['html', 'js', 'css', 'json', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'woff', 'woff2', 'mp3', 'mp4', 'webm', 'txt']);
  const CONCURRENCY = 3;

  const extOf = (p) => { const s = p.lastIndexOf('/'), d = p.lastIndexOf('.'); return d > s ? p.slice(d + 1).toLowerCase() : ''; };
  function checkPath(v) {
    if (v.length > LIM.pathLen) return `路徑最長 ${LIM.pathLen} 字元`;
    if (!PATH_RE.test(v)) return '路徑只能用 A-Z a-z 0-9 . _ - 與 /，且須為相對路徑';
    if (v.split('/').length > LIM.pathDepth) return `路徑最多 ${LIM.pathDepth} 層`;
    if (v.includes('..') || DOT_SEGMENT_RE.test(v)) return '路徑不得含 . 或 .. 片段';
    if (!EXTS.has(extOf(v))) return '不允許的副檔名';
    return null;
  }

  // ---- 顯示不受信任字串：控制字元與雙向覆寫字元換成可見標記，超長截斷（只產生文字，交給 el() 當文字節點）----
  // 範圍：C0／C1 控制字元、U+061C、零寬與雙向標記 U+200B–U+200F、U+2028–U+202E、U+2060–U+2069、U+FEFF（以字碼產生，避免原始碼內含不可見字元）
  const INVISIBLE_RE = new RegExp('[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
    .map(([a, b]) => [a, b].map((c) => String.fromCharCode(92) + 'u' + c.toString(16).padStart(4, '0')).join('-')).join('') + ']', 'g');
  function shown(v, max = 120) {
    let s = String(v ?? '');
    const len = s.length;
    if (len > max) s = s.slice(0, max);
    s = s.replace(INVISIBLE_RE, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
    return len > max ? `${s}…（共 ${len} 字）` : s;
  }
  const fmtBytes = (n) => (n >= MiB ? `${(n / MiB).toFixed(1)} MB` : n >= KiB ? `${(n / KiB).toFixed(1)} KB` : `${n} B`);
  const fmtTime = (ms) => { const d = new Date(Number(ms)); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };

  class PreError extends Error {}
  const utf8 = new TextDecoder('utf-8');
  const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

  // ---- zip 讀取：只解析中央目錄，支援 store（0）與 deflate（8）；不支援 ZIP64、分割、加密 ----
  function readCentralDirectory(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 22) throw new PreError('不是有效的 zip 檔');
    let eocd = -1;
    const stop = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= stop; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new PreError('不是有效的 zip 檔（找不到中央目錄）');
    const disk = dv.getUint16(eocd + 4, true), cdDisk = dv.getUint16(eocd + 6, true);
    const nHere = dv.getUint16(eocd + 8, true), nTotal = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
    if (disk !== 0 || cdDisk !== 0 || nHere !== nTotal) throw new PreError('不支援分割的 zip 檔');
    if (nTotal === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new PreError('不支援 ZIP64 格式');
    if (nTotal > LIM.zipEntriesMax) throw new PreError(`zip 內的項目超過 ${LIM.zipEntriesMax} 個`);
    if (cdOff + cdSize > eocd) throw new PreError('zip 檔已損毀（中央目錄超出範圍）');
    const end = cdOff + cdSize;
    const entries = [];
    let p = cdOff;
    for (let i = 0; i < nTotal; i++) {
      if (p + 46 > end || dv.getUint32(p, true) !== 0x02014b50) throw new PreError('zip 檔已損毀（中央目錄項目不正確）');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      if (p + 46 + nameLen > end) throw new PreError('zip 檔已損毀（檔名超出範圍）');
      const name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (p > end) throw new PreError('zip 檔已損毀（中央目錄項目超出範圍）');
      entries.push({ name, flags, method, compSize, size, localOff });
    }
    return entries;
  }

  // 解壓單一項目：邊解壓邊計數，超過宣告大小（宣告大小已先受單檔上限約束）就立即中止
  async function extractEntry(buf, e, signal) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const lo = e.localOff;
    if (lo + 30 > buf.length || dv.getUint32(lo, true) !== 0x04034b50) throw new PreError('zip 檔已損毀（找不到檔案標頭）');
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const stop = start + e.compSize;
    if (stop > buf.length) throw new PreError('zip 檔已損毀（壓縮資料超出範圍）');
    if (e.method === 0) {
      if (e.compSize !== e.size) throw new PreError('zip 檔已損毀（未壓縮項目的大小不一致）');
      return buf.slice(start, stop);
    }
    const out = new Uint8Array(e.size);
    const reader = new Blob([buf.subarray(start, stop)]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let got = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new PreError('已取消');
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > e.size) throw new PreError('解壓後的大小超過 zip 宣告的大小（已中止解壓）');
        out.set(value, got);
        got += value.length;
      }
    } catch (err) {
      try { await reader.cancel(); } catch { /* 略過 */ }
      if (err instanceof PreError) throw err;
      throw new PreError('解壓失敗（資料損毀或格式不支援）');
    }
    if (got !== e.size) throw new PreError('解壓後的大小與 zip 宣告的大小不符');
    return out;
  }

  const hex = (ab) => Array.from(new Uint8Array(ab), (b) => b.toString(16).padStart(2, '0')).join('');

  // 選檔 → 解壓與預檢。成功回 { deckText, deck, files:[{path,size,sha256,bytes}], bodyText, total }；
  // 預檢不通過丟 PreError，或回 { errors:[{name,message}] }（可一次列出多筆）
  async function prepare(file, signal, onStep) {
    if (file.size > LIM.zipBytesMax) throw new PreError(`zip 檔超過 ${fmtBytes(LIM.zipBytesMax)}`);
    const buf = new Uint8Array(await file.arrayBuffer());
    const raw = readCentralDirectory(buf);
    const errors = [];
    const add = (name, message) => { if (errors.length < 50) errors.push({ name, message }); };

    // 忽略資料夾項目與作業系統附帶的中繼檔
    let entries = raw.filter((e) => !e.name.endsWith('/') && !/^__MACOSX\//.test(e.name) && !/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(e.name));
    const ignored = raw.length - entries.length;
    // 整個資料夾被壓成 zip（所有檔案都在同一個頂層資料夾、deck.json 在其中）時，去掉該資料夾
    if (!entries.some((e) => e.name.toLowerCase() === 'deck.json')) {
      const top = entries.length ? entries[0].name.split('/')[0] + '/' : '';
      if (top.length > 1 && entries.every((e) => e.name.startsWith(top)) && entries.some((e) => e.name.toLowerCase() === (top + 'deck.json').toLowerCase())) {
        entries = entries.map((e) => ({ ...e, name: e.name.slice(top.length) }));
      }
    }
    const deckEntries = entries.filter((e) => e.name.toLowerCase() === 'deck.json');
    if (deckEntries.length === 0) add('deck.json', 'zip 最上層找不到 deck.json');
    if (deckEntries.length > 1) add('deck.json', 'deck.json 重複（大小寫不分）');
    const fileEntries = entries.filter((e) => e.name.toLowerCase() !== 'deck.json');

    // 1. 只看中央目錄就能做的檢查（不解壓）：路徑、加密、壓縮方式、大小、數量、重複
    if (fileEntries.length < 1 || fileEntries.length > LIM.filesMax) add('', `deck.json 以外的檔案數必須是 1–${LIM.filesMax} 個（目前 ${fileEntries.length} 個）`);
    const seen = new Set();
    let total = 0;
    for (const e of fileEntries) {
      const perr = checkPath(e.name);
      if (perr) { add(e.name, perr); continue; }
      const lower = e.name.toLowerCase();
      if (seen.has(lower)) add(e.name, '檔案路徑重複（大小寫不分）');
      seen.add(lower);
      if (e.flags & 1) add(e.name, '不支援加密的 zip');
      else if (e.method !== 0 && e.method !== 8) add(e.name, '不支援的壓縮方式（只支援 store 與 deflate）');
      if (e.size < 1 || e.size > LIM.fileBytesMax) add(e.name, `單檔大小必須是 1 位元組到 10 MB（目前 ${fmtBytes(e.size)}）`);
      total += e.size;
    }
    if (total > LIM.totalBytesMax) add('', `檔案總和超過 60 MB（目前 ${fmtBytes(total)}）`);
    for (const e of deckEntries) {
      if (e.flags & 1) add('deck.json', '不支援加密的 zip');
      else if (e.method !== 0 && e.method !== 8) add('deck.json', '不支援的壓縮方式（只支援 store 與 deflate）');
      if (e.size > LIM.deckBytes) add('deck.json', 'deck.json 超過 128 KiB');
    }
    if (errors.length) return { errors, ignored };

    // 2. deck.json：UTF-8、可解析、id／version 格式，entry 與 html 頁都在清單中（完整契約由伺服器驗證）
    onStep('解壓 deck.json…');
    const deckBytes = await extractEntry(buf, deckEntries[0], signal);
    let deckText, deck;
    try { deckText = utf8Fatal.decode(deckBytes); } catch { return { errors: [{ name: 'deck.json', message: 'deck.json 不是合法的 UTF-8 文字' }], ignored }; }
    try { deck = JSON.parse(deckText); } catch { return { errors: [{ name: 'deck.json', message: 'deck.json 不是合法 JSON' }], ignored }; }
    if (deck === null || typeof deck !== 'object' || Array.isArray(deck)) return { errors: [{ name: 'deck.json', message: 'deck.json 必須是 JSON 物件' }], ignored };
    if (typeof deck.id !== 'string' || !DECK_ID_RE.test(deck.id)) add('deck.json', 'id 格式不正確（小寫英數與 -，2–48 字）');
    if (typeof deck.version !== 'string' || !DECK_VERSION_RE.test(deck.version)) add('deck.json', 'version 格式不正確（英數、. 與 -，最多 32 字）');
    const exact = new Set(fileEntries.map((e) => e.name));
    if (typeof deck.entry !== 'string' || !exact.has(deck.entry)) add('deck.json', 'entry 指定的檔案不在 zip 中');
    if (Array.isArray(deck.pages)) deck.pages.forEach((pg, i) => {
      if (pg && pg.type === 'html' && (typeof pg.path !== 'string' || !exact.has(pg.path))) add('deck.json', `第 ${i + 1} 頁（html）指定的檔案不在 zip 中`);
    });
    if (errors.length) return { errors, ignored };

    // 3. 逐檔解壓並算 SHA-256（不預覽、不解析內容）
    const files = [];
    for (let i = 0; i < fileEntries.length; i++) {
      if (signal.aborted) throw new PreError('已取消');
      const e = fileEntries[i];
      onStep(`解壓並計算雜湊 ${i + 1} / ${fileEntries.length}`);
      const bytes = await extractEntry(buf, e, signal);
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
      files.push({ path: e.name, size: bytes.length, sha256, bytes });
    }
    const bodyText = JSON.stringify({ deck: deckText, files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) });
    if (new TextEncoder().encode(bodyText).length > LIM.bodyBytes) return { errors: [{ name: '', message: '檔案清單與 deck.json 合計超過 512 KiB' }], ignored };
    return { deckText, deck, files, bodyText, total, ignored };
  }

  // ---- 網路 ----
  async function call(path, { method = 'POST', body, json = true, signal } = {}) {
    let r;
    try {
      r = await fetch(path, { method, credentials: 'same-origin', ...(json ? { headers: { 'content-type': 'application/json' } } : {}), ...(body !== undefined ? { body } : {}), ...(signal ? { signal } : {}) });
    } catch (err) {
      return { ok: false, status: 0, data: { error: err && err.name === 'AbortError' ? '已取消' : '網路連線失敗' }, aborted: err && err.name === 'AbortError' };
    }
    let data = {};
    try { data = await r.json(); } catch { /* 非 JSON 回應 */ }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) data = {};
    return { ok: r.ok, status: r.status, data };
  }

  // ---- 畫面 ----
  const $ = (id) => document.getElementById(id);
  const sec = $('deckSec');
  if (!sec) return;
  const input = $('deckFile');
  const stateBox = $('deckState');
  const listBody = $('deckList');
  const listMsg = $('deckListMsg');

  let current = null; // { prep, uploadId, ctrl, phase }

  function setState(state, ...kids) {
    sec.dataset.state = state;
    stateBox.replaceChildren(...kids.filter((k) => k != null));
  }
  const btn = (label, onclick, extra = {}) => el('button', { type: 'button', onclick, ...extra }, label);

  function errorList(items) {
    return el('ul', { class: 'deck-errors' }, items.map((x) => el('li', {},
      x.name ? el('code', { class: 'deck-path' }, shown(x.name)) : null,
      x.name ? '：' : null,
      shown(x.message, 300))));
  }

  // 伺服器錯誤（含 path、missing、errors）→ 只產生文字節點
  function serverError(res, prep) {
    const d = res.data || {};
    const lines = [];
    const head = `${shown(d.error || (res.status ? `伺服器回應 ${res.status}` : '網路連線失敗'), 300)}${d.code ? `（${shown(d.code, 40)}）` : ''}${res.status ? `［HTTP ${res.status}］` : ''}`;
    lines.push(el('p', { class: 'msg' }, head));
    const details = [];
    if (typeof d.path === 'string') {
      let extra = '';
      const m = /^\/files\/(\d+)/.exec(d.path);
      if (m && prep && prep.files[Number(m[1])]) extra = `（${prep.files[Number(m[1])].path}）`;
      details.push({ name: '欄位', message: `${d.path}${extra}` });
    }
    if (Array.isArray(d.missing)) details.push({ name: '缺少的檔案序號', message: d.missing.slice(0, 50).map((i) => (prep && prep.files[i] ? `${i}（${prep.files[i].path}）` : String(i))).join('、') });
    if (Array.isArray(d.errors)) for (const e of d.errors.slice(0, 20)) if (e && typeof e === 'object') details.push({ name: String(e.path ?? ''), message: String(e.message ?? '') });
    if (typeof d.state === 'string') details.push({ name: '狀態', message: d.state });
    if (details.length) lines.push(errorList(details));
    return lines;
  }

  function showIdle(note) {
    current = null;
    input.value = '';
    input.disabled = false;
    setState('idle', note ? el('p', { class: 'hint' }, note) : el('p', { class: 'hint' }, '尚未選擇檔案。'));
  }

  async function onPick() {
    const file = input.files && input.files[0];
    if (!file) return;
    const ctrl = new AbortController();
    current = { ctrl, phase: 'checking' };
    input.disabled = true;
    const step = el('span', {}, '讀取 zip…');
    setState('checking',
      el('p', {}, '檔案：', el('code', { class: 'deck-path' }, shown(file.name)), `（${fmtBytes(file.size)}）`),
      el('p', { role: 'status', 'aria-live': 'polite' }, step),
      el('div', { class: 'row' }, btn('取消', () => { ctrl.abort(); showIdle('已取消檢查。'); })));
    let res;
    try {
      res = await prepare(file, ctrl.signal, (t) => { step.textContent = t; });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      res = { errors: [{ name: '', message: err instanceof PreError ? err.message : '無法讀取這個 zip 檔' }] };
    }
    if (ctrl.signal.aborted || current?.ctrl !== ctrl) return;
    input.disabled = false;
    if (res.errors) {
      current = null;
      setState('precheck-error',
        el('p', { class: 'msg' }, `預檢沒有通過，沒有上傳任何檔案（${res.errors.length} 項問題）：`),
        errorList(res.errors),
        el('div', { class: 'row' }, btn('重新選擇檔案', () => { showIdle(); input.click(); })));
      return;
    }
    current = { prep: res, phase: 'ready' };
    showReady(res, file.name);
  }

  function showReady(prep, zipName) {
    const rows = prep.files.map((f) => el('tr', {}, el('td', { class: 'deck-path' }, shown(f.path)), el('td', { class: 'num' }, fmtBytes(f.size))));
    setState('ready',
      el('p', {}, '預檢通過：', el('strong', {}, shown(prep.deck.title ?? '（無標題）')), ' ',
        el('code', { class: 'deck-path' }, `${shown(prep.deck.id)} / ${shown(prep.deck.version)}`)),
      el('p', { class: 'hint' }, `${prep.files.length} 個檔案，共 ${fmtBytes(prep.total)}${prep.ignored ? `；已略過 ${prep.ignored} 個資料夾或系統檔` : ''}。`,
        zipName ? el('span', {}, '（', el('code', { class: 'deck-path' }, shown(zipName)), '）') : null),
      el('div', { class: 'deck-files' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, '路徑'), el('th', { class: 'num' }, '大小'))), el('tbody', {}, rows))),
      el('div', { class: 'row' },
        btn('開始上傳', () => upload(prep), { class: 'primary', id: 'deckUpload' }),
        btn('重新選擇', () => { showIdle(); input.click(); })));
  }

  async function upload(prep) {
    const ctrl = new AbortController();
    const job = { prep, ctrl, uploadId: null, phase: 'begin', cancelled: false };
    current = job;
    input.disabled = true;
    const n = prep.files.length;
    let doneFiles = 0, doneBytes = 0;
    const bar = el('progress', { max: String(prep.total), value: '0' });
    const label = el('span', {}, '建立上傳…');
    const cancelBtn = btn('取消上傳', () => cancel(job), { id: 'deckCancel' });
    setState('uploading',
      el('p', {}, '上傳中：', el('strong', {}, shown(prep.deck.title ?? '')), ' ', el('code', { class: 'deck-path' }, `${shown(prep.deck.id)} / ${shown(prep.deck.version)}`)),
      bar,
      el('p', { role: 'status', 'aria-live': 'polite' }, label),
      el('div', { class: 'row' }, cancelBtn));
    const progress = () => { bar.value = doneBytes; label.textContent = `已上傳 ${doneFiles} / ${n} 個檔案（${fmtBytes(doneBytes)} / ${fmtBytes(prep.total)}）`; };

    let failure = null;
    // [1] 開始上傳：不中斷這個請求（否則伺服器可能已建立上傳、但瀏覽器拿不到 uploadId 而無法中止）；取消在回應後處理
    const b = await call('/api/admin/deck-uploads', { body: prep.bodyText });
    if (b.ok && typeof b.data.uploadId === 'string' && UPLOAD_ID_RE.test(b.data.uploadId)) job.uploadId = b.data.uploadId;
    else if (b.ok) failure = { status: b.status, data: { error: '伺服器回應的 uploadId 格式不正確' } };
    else failure = b;

    // [2] 逐檔上傳，同時最多 3 個；任何一個失敗就停止排程並中斷其他進行中的請求
    if (!failure && !job.cancelled) {
      job.phase = 'files';
      progress();
      let next = 0;
      const worker = async () => {
        while (!failure && !job.cancelled && next < n) {
          const i = next++;
          const f = prep.files[i];
          const r = await call(`/api/admin/deck-uploads/${job.uploadId}/files/${i}`, { method: 'PUT', body: f.bytes, json: false, signal: ctrl.signal });
          if (!r.ok) {
            if (!failure && !job.cancelled) { failure = r.status === 0 && !r.data.path ? { ...r, data: { ...r.data, path: `/files/${i}` } } : r; ctrl.abort(); }
            return;
          }
          doneFiles++; doneBytes += f.size;
          progress();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, n) }, worker));
    }

    // [3] 確認（開始確認後不能再取消）
    if (!failure && !job.cancelled) {
      job.phase = 'commit';
      cancelBtn.disabled = true;
      label.textContent = '確認中…';
      const c = await call(`/api/admin/deck-uploads/${job.uploadId}/commit`, { body: '{}' });
      if (c.ok) {
        job.phase = 'done';
        current = null;
        input.disabled = false;
        input.value = '';
        setState('done',
          el('p', {}, '上傳完成：', el('strong', {}, shown(prep.deck.title ?? '')), ' ', el('code', { class: 'deck-path' }, `${shown(prep.deck.id)} / ${shown(prep.deck.version)}`)),
          el('div', { class: 'row' }, btn('再上傳一份', () => { showIdle(); input.click(); })));
        loadList();
        return;
      }
      failure = c;
    }

    // 失敗或取消：已建立的上傳一律中止（用新的請求，不受已中斷的 signal 影響）
    job.phase = 'aborting';
    cancelBtn.disabled = true;
    let abortNote = null;
    if (job.uploadId) {
      label.textContent = '中止這次上傳…';
      const a = await call(`/api/admin/deck-uploads/${job.uploadId}/abort`, { body: '{}' });
      abortNote = a.ok ? '已中止這次上傳，伺服器會清除已上傳的檔案。同一組 id 與 version 不能再使用，請修改 deck.json 的 version 後重新選擇檔案。'
        : `中止這次上傳失敗：${shown(a.data.error || `HTTP ${a.status}`, 200)}（未完成的上傳會在 30 分鐘後自動清除）`;
    }
    current = null;
    input.disabled = false;
    if (job.cancelled) {
      setState('cancelled', el('p', { class: 'msg' }, '已取消上傳。'), abortNote ? el('p', { class: 'hint' }, abortNote) : null,
        el('div', { class: 'row' }, btn('重試', () => upload(prep), { id: 'deckRetry' }), btn('重新選擇檔案', () => { showIdle(); input.click(); })));
      return;
    }
    setState('error', ...serverError(failure, prep), abortNote ? el('p', { class: 'hint' }, abortNote) : null,
      el('div', { class: 'row' }, btn('重試', () => upload(prep), { id: 'deckRetry' }), btn('重新選擇檔案', () => { showIdle(); input.click(); })));
  }

  function cancel(job) {
    if (job.phase !== 'begin' && job.phase !== 'files') return;
    job.cancelled = true;
    job.ctrl.abort();
    const b = document.getElementById('deckCancel');
    if (b) b.disabled = true;
  }

  // ---- 列表：停用、撤銷（撤銷前確認）----
  async function loadList() {
    const r = await call('/api/decks', { method: 'GET', json: false });
    if (!r.ok || !Array.isArray(r.data.decks)) {
      listBody.replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'hint' }, shown(r.data.error || '載入失敗', 200))));
      return;
    }
    if (!r.data.decks.length) { listBody.replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'hint' }, '簡報庫目前是空的'))); return; }
    listBody.replaceChildren(...r.data.decks.map((d) => {
      const id = String(d.id ?? ''), version = String(d.version ?? '');
      const target = `/api/admin/decks/${encodeURIComponent(id)}/${encodeURIComponent(version)}/`;
      const act = async (action) => {
        if (action === 'revoke' && !confirm(`撤銷「${shown(d.title, 60)}」（${shown(id, 48)} / ${shown(version, 32)}）？撤銷後檔案會被刪除，無法復原，同一組 id 與版本也不能再使用。`)) return;
        listMsg.textContent = '';
        const x = await call(target + action, { body: '{}' });
        if (!x.ok) listMsg.replaceChildren(...serverError(x, null));
        loadList();
      };
      const stateText = d.state === 'ready' ? '可用' : d.state === 'disabled' ? '已停用' : shown(d.state, 20);
      return el('tr', { 'data-deck': `${id}/${version}` },
        el('td', { class: 'deck-title' }, shown(d.title, 120)),
        el('td', { class: 'deck-path' }, `${shown(id, 48)} / ${shown(version, 32)}`),
        el('td', {}, stateText),
        el('td', { class: 'hint' }, fmtTime(d.created_at)),
        el('td', { class: 'deck-actions' },
          d.state === 'ready' ? btn('停用', () => act('disable'), { 'data-action': 'disable' }) : null,
          btn('撤銷', () => act('revoke'), { 'data-action': 'revoke' })));
    }));
  }

  input.addEventListener('change', onPick);
  $('deckRefresh').addEventListener('click', () => { listMsg.textContent = ''; loadList(); });

  // teacher.html 在確認管理者身分後才顯示講師名單（#adminSec）；簡報庫跟著它顯示，第一次顯示時載入列表
  const admin = $('adminSec');
  let loaded = false;
  const sync = () => {
    sec.hidden = !admin || admin.hidden;
    if (!sec.hidden && !loaded) { loaded = true; showIdle(); loadList(); }
  };
  if (admin) new MutationObserver(sync).observe(admin, { attributes: true, attributeFilter: ['hidden'] });
  sync();
})();
