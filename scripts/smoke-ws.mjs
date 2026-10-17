// 本機冒煙測試：模擬講師＋兩位研習者，驗證建場、加入、翻頁同步、留言、投票、筆跡、權限與結束刪除。
// 用法：先啟動 wrangler dev（預設 http://127.0.0.1:8801），再執行
//   CREATE_SECRET=<本機 .dev.vars 的值> node scripts/smoke-ws.mjs [base]
// 需要 Node 22+（內建 WebSocket）。
// WebSocket 連線一律帶 Origin＝主站 origin（S3d-B：伺服器拒絕沒有 Origin 或 Origin 不符的升級請求）。
import http from "node:http";
const base = process.argv[2] || "http://127.0.0.1:8801";
const ORIGIN = new URL(base).origin;
const secret = process.env.CREATE_SECRET;
if (!secret) { console.error("請以環境變數 CREATE_SECRET 提供本機建場密語"); process.exit(2); }

let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(code, hello) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${code}/ws`, { headers: { origin: ORIGIN } });
  const inbox = [];
  const c = {
    ws, inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: async (pred, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await sleep(20);
      }
      return null;
    },
  };
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
  c.ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => { c.send({ type: "hello", ...hello }); res(); });
    ws.addEventListener("error", rej);
  });
  return c;
}

const health = await (await fetch(`${base}/api/health`)).json();
ok(health.app === "ptt-teach", "健康檢查回應本專案特有欄位");

const bad = await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ secret: "wrong" }) });
ok(bad.status === 403, "錯誤建場密語被拒（403）");

const created = await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ secret }) })).json();
ok(/^[A-Z0-9]{6}$/.test(created.code) && created.key, "建場成功並取得加入碼與講師金鑰");
const { code, key } = created;

const info = await (await fetch(`${base}/api/rooms/${code}`)).json();
ok(info.exists === true, "查詢場次存在");
const none = await (await fetch(`${base}/api/rooms/ZZZZZZ`)).json();
ok(none.exists === false, "不存在的加入碼回報不存在");

// ---- WebSocket 升級的 Origin 檢查（S3d-B）：用 node:http 送原始升級請求，觀察 HTTP 狀態碼與回應本體 ----
// 本機 wrangler dev 的限制（正式環境沒有這兩層）：
// - miniflare 會先擋掉主機名不是迴環位址、或無法解析的 Origin（含 "null"）→ 403，但回應不是本 Worker 的 JSON；
// - wrangler 的代理會把「主機與連接埠相同、協定不同」的 Origin 改寫成 http，所以協定不同的情況在本機無法測。
// 會進到 Worker 的情況（沒有 Origin、簡報主機 origin、結尾多斜線、主機名不同）另外核對本 Worker 的錯誤本體。
function upgrade(origin) {
  const u = new URL(base);
  const headers = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64") };
  if (origin !== undefined) headers.origin = origin;
  return new Promise((resolve) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: `/api/rooms/${code}/ws`, headers, timeout: 10000 });
    r.on("upgrade", (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, body: "" }); });
    r.on("response", (res) => { let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", () => resolve({ status: 0, body: "" }));
    r.end();
  });
}
const byWorker = (r) => { try { return r.status === 403 && JSON.parse(r.body).error === "來源不符"; } catch { return false; } };
const altHost = ORIGIN.includes("127.0.0.1") ? ORIGIN.replace("127.0.0.1", "localhost") : ORIGIN.replace("localhost", "127.0.0.1");
ok((await upgrade(ORIGIN)).status === 101, "WebSocket：Origin 等於主站時可以升級（正向對照）");
ok(byWorker(await upgrade(undefined)), "WebSocket：沒有 Origin 的升級被 Worker 拒絕（403）");
ok(byWorker(await upgrade("http://127.0.0.1:8802")), "WebSocket：簡報主機 origin（127.0.0.1:8802）的升級被 Worker 拒絕（403）");
ok(byWorker(await upgrade(ORIGIN + "/")), "WebSocket：Origin 多一個結尾斜線也被 Worker 拒絕（完全相等才放行）");
ok(byWorker(await upgrade(altHost)), `WebSocket：主機名不同（${altHost}）的升級被 Worker 拒絕`);
ok((await upgrade("null")).status === 403, "WebSocket：Origin 為 \"null\"（sandbox 簡報頁）的升級被拒（本機由 miniflare 先擋）");
ok((await upgrade("https://evil.example")).status === 403, "WebSocket：其他網站 origin 的升級被拒（本機由 miniflare 先擋）");
const noOrigin = await new Promise((resolve) => {
  const s = new WebSocket(`${base.replace(/^http/, "ws")}/api/rooms/${code}/ws`);
  s.addEventListener("open", () => { s.close(); resolve("open"); });
  s.addEventListener("error", () => resolve("error"));
  setTimeout(() => resolve("timeout"), 4000);
});
ok(noOrigin === "error", "WebSocket：不帶 Origin 的用戶端連不上");

const P = client(code, { pid: "presenter-0001", name: "講師", key });
const A = client(code, { pid: "alice-000001", name: "小美" });
const B = client(code, { pid: "bob-00000001", name: "阿明" });
await Promise.all([P.ready, A.ready, B.ready]);
const pi = await P.wait((m) => m.type === "init");
const ai = await A.wait((m) => m.type === "init");
ok(pi?.me.role === "presenter", "講師金鑰取得講師身分");
ok(ai?.me.role === "participant", "研習者為一般身分");

const fake = client(code, { pid: "mallory-0001", name: "假講師", key: "not-the-key" });
await fake.ready;
const fe = await fake.wait((m) => m.type === "error");
ok(!!fe, "錯誤講師金鑰被拒");
fake.ws.close();

// 翻頁同步
P.send({ type: "pres", page: 9, t: 0, playing: false });
const ap = await A.wait((m) => m.type === "pres");
ok(ap?.pres.page === 9, "講師翻頁同步給研習者");
A.send({ type: "pres", page: 3, t: 0, playing: false });
const ae = await A.wait((m) => m.type === "error");
ok(!!ae, "研習者不能控制翻頁");

// 講師名單：跟隨／自由（只送講師）
A.send({ type: "state", mode: "free", page: 5 });
const roster = await P.wait((m) => m.type === "roster" && m.people.some((x) => x.pid === "alice-000001" && x.mode === "free" && x.page === 5));
ok(!!roster, "講師收到名單：小美自由觀看第 6 頁");
ok(!!roster && roster.people.some((x) => x.pid === "bob-00000001" && x.mode === "follow"), "名單顯示阿明跟隨中");
await sleep(200);
ok(!A.inbox.some((m) => m.type === "roster") && !B.inbox.some((m) => m.type === "roster"), "研習者收不到名單");

// 留言
A.send({ type: "note.add", page: 13, text: "回饋學生作品" });
const bn = await B.wait((m) => m.type === "note");
ok(bn?.note.text === "回饋學生作品" && bn.note.name === "小美", "留言即時廣播給其他人");
A.send({ type: "note.add", page: 13, text: "太快的第二則" });
ok(!!(await A.wait((m) => m.type === "error")), "留言頻率限制生效");
A.send({ type: "note.add", page: 2, text: "動畫頁不能留言" });
ok(!!(await A.wait((m) => m.type === "error")), "非討論頁不能留言");
B.send({ type: "note.add", page: 9, text: "公文來回等待", tag: 4, tag2: 2 });
const mapNote = await A.wait((m) => m.type === "note" && m.note.page === 9);
ok(mapNote?.note.tag === 4 && mapNote.note.tag2 === 2, "阻塞點地圖留言帶節點與類型");
B.send({ type: "note.del", id: bn.note.id });
ok(!!(await B.wait((m) => m.type === "error")), "不能刪除別人的留言");
P.send({ type: "note.pin", id: bn.note.id, pinned: true });
ok((await A.wait((m) => m.type === "note.pin"))?.pinned === 1, "講師置頂留言");

// 投票
A.send({ type: "vote", page: 4, opt: 1 });
B.send({ type: "vote", page: 4, opt: 1 });
await sleep(300);
B.send({ type: "vote", page: 4, opt: 2 });
await sleep(300);
const votes = P.inbox.filter((m) => m.type === "votes" && m.page === 4).pop();
const vlist = P.inbox.filter((m) => m.type === "voters" && m.page === 4).pop();
ok(JSON.stringify(vlist?.voters) === JSON.stringify([[], ["小美"], ["阿明"]]), `講師看得到投票者（${JSON.stringify(vlist?.voters)}）`);
ok(!A.inbox.some((m) => m.type === "voters") && !B.inbox.some((m) => m.type === "voters"), "研習者收不到投票者名單");
ok(JSON.stringify(votes?.counts) === "[0,1,1]", `投票可改選且即時統計（${JSON.stringify(votes?.counts)}）`);

// 筆跡
A.send({ type: "stroke", page: 9, color: "#f2c14e", w: 5, pts: [10, 10, 50, 60, 90, 80], cid: "c1" });
const st = await B.wait((m) => m.type === "stroke");
ok(st?.stroke.pts.length === 6, "筆跡即時廣播");
ok(st && !("name" in st.stroke), "研習者收到的筆跡不含作者");
const pst = await P.wait((m) => m.type === "stroke");
ok(pst?.stroke.name === "小美", "講師收到的筆跡帶作者暱稱");
A.send({ type: "stroke", page: 9, color: "#f2c14e", w: 5, pts: [10, 10, 5000, 60] });
await sleep(300);
ok(!B.inbox.some((m) => m.type === "stroke"), "超出範圍的筆跡被拒");

// 講師在動畫頁標註（筆跡＋文字）；學員不能在動畫頁畫或加文字
P.send({ type: "stroke", page: 2, color: "#f2c14e", w: 5, pts: [100, 100, 200, 200], cid: "p1" });
ok((await A.wait((m) => m.type === "stroke" && m.stroke.page === 2))?.stroke.pid === "presenter-0001", "講師可以在動畫頁畫筆跡");
A.send({ type: "stroke", page: 2, color: "#f2c14e", w: 5, pts: [100, 100, 200, 200] });
ok(!!(await A.wait((m) => m.type === "error")), "學員不能在動畫頁畫筆跡");
P.send({ type: "label.add", page: 2, x: 300, y: 400, text: "注意這裡", color: "#f2c14e" });
const lb = await B.wait((m) => m.type === "label");
ok(lb?.label.text === "注意這裡" && lb.label.page === 2, "講師在動畫頁加文字，學員即時看到");
A.send({ type: "label.add", page: 2, x: 10, y: 10, text: "我也要" });
ok(!!(await A.wait((m) => m.type === "error")), "學員不能加文字標註");
P.send({ type: "label.add", page: 2, x: 9999, y: 10, text: "超出" });
ok(!!(await P.wait((m) => m.type === "error")), "超出範圍的文字標註被拒");
P.send({ type: "label.add", page: 2, x: 10, y: 10, text: "字".repeat(61) });
ok(!!(await P.wait((m) => m.type === "error")), "超過 60 字的文字標註被拒");
P.send({ type: "label.del", id: lb.label.id });
ok((await B.wait((m) => m.type === "label.del"))?.id === lb.label.id, "講師刪除文字標註，學員同步移除");
P.send({ type: "label.add", page: 2, x: 500, y: 500, text: "第二段", color: "#7fb6d9" });
await B.wait((m) => m.type === "label");
P.send({ type: "stroke.clear", page: 2 });
ok((await B.wait((m) => m.type === "stroke.clear"))?.page === 2, "講師清除動畫頁標註");

// 重連後拿到完整快照
const A2 = client(code, { pid: "alice-000001", name: "小美" });
await A2.ready;
const snap = await A2.wait((m) => m.type === "init");
ok(snap?.notes.length === 2 && snap.strokes.length === 1 && snap.myVotes[4] === 1 && snap.pres.page === 9, "重新連線取得留言、筆跡、我的投票與講師頁面");
ok(Array.isArray(snap?.labels) && snap.labels.length === 0, "清除後快照沒有殘留文字標註");
ok(snap && !("name" in snap.strokes[0]) && Object.keys(snap.voters).length === 0, "研習者快照不含筆跡作者與投票者");
const P2 = client(code, { pid: "presenter-0001", name: "講師", key });
await P2.ready;
const psnap = await P2.wait((m) => m.type === "init");
ok(psnap?.strokes[0].name === "小美" && JSON.stringify(psnap.voters[4]) === JSON.stringify([[], ["小美"], ["阿明"]]), "講師快照含筆跡作者與投票者");

// 結束並刪除
A.send({ type: "room.end" });
ok(!!(await A.wait((m) => m.type === "error")), "研習者不能結束場次");
P.send({ type: "room.end" });
ok(!!(await B.wait((m) => m.type === "ended")), "講師結束後所有人收到通知");
await sleep(300);
const after = await (await fetch(`${base}/api/rooms/${code}`)).json();
ok(after.exists === false, "結束後場次與資料已刪除");

for (const c of [P, A, B, A2, P2]) try { c.ws.close(); } catch {}

// ---- deck 快照驗證（S3b-2）：另開一場，避免影響上面的快照計數 ----
// 預設 deck（examples/ai-era-education.deck.json）：22 頁、總長 223 秒；
// 4＝投票 3 選項、9＝地圖 8 節點／4 標籤、10＝投票 6 選項、13／16＝留言牆、20＝三欄、其餘為動畫頁。
// 被靜默丟棄的訊息用「之後送一則合法標記訊息，下一則同類型訊息必須是標記」判斷（同一連線依序處理）。
const PAGE_COUNT_EXPECTED = 22, MAX_SEEK = 223;
const BAD_PAGES = [PAGE_COUNT_EXPECTED, -1, "4"];
const room2 = await (await fetch(`${base}/api/rooms`, { method: "POST", body: JSON.stringify({ secret }) })).json();
const Q = client(room2.code, { pid: "presenter-0002", name: "講師", key: room2.key });
const C = client(room2.code, { pid: "carol-000001", name: "小芳" });
await Promise.all([Q.ready, C.ready]);
const qi = await Q.wait((m) => m.type === "init");
const ci = await C.wait((m) => m.type === "init");
const deckKeys = ["contract", "id", "title", "version", "entry", "runtime", "segments", "pages"];
ok(ci?.deck?.pages?.length === PAGE_COUNT_EXPECTED && Object.keys(ci.deck).every((k) => deckKeys.includes(k)) && ci.deck.pages[4].kind === "vote", "init 帶驗證後的 deck 快照（只含契約欄位）");
ok(JSON.stringify(Object.keys(ci?.votes || {})) === '["4","10"]' && ci.votes[4].length === 3 && ci.votes[10].length === 6, "init 的投票陣列依 deck 選項數建立");
ok(JSON.stringify(qi?.voters?.[10]) === JSON.stringify([[], [], [], [], [], []]), "講師 init 的投票者名單依 deck 選項數建立");
const clearErrors = (c) => { for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].type === "error") c.inbox.splice(i, 1); };

// state：deck 以外的頁碼視為沒有所在頁
let stateOk = true;
const drain = (c, type) => { for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].type === type) c.inbox.splice(i, 1); };
for (const bp of BAD_PAGES) {
  drain(Q, "roster");
  C.send({ type: "state", mode: "free", page: 5 });
  const r1 = await Q.wait((m) => m.type === "roster" && m.people.some((x) => x.pid === "carol-000001" && x.page === 5));
  drain(Q, "roster");
  C.send({ type: "state", mode: "free", page: bp });
  const r2 = await Q.wait((m) => m.type === "roster" && m.people.some((x) => x.pid === "carol-000001" && x.mode === "free"));
  const me2 = r2?.people.find((x) => x.pid === "carol-000001");
  if (!r1 || me2?.page !== null) { stateOk = false; console.log(`  state page=${JSON.stringify(bp)} → ${JSON.stringify(me2)}`); }
}
ok(stateOk, "state：頁碼 = 頁數、-1、\"4\" 都不被採用");

// pres：deck 以外的頁碼被丟棄
for (const bp of BAD_PAGES) Q.send({ type: "pres", page: bp, t: 0, playing: false });
Q.send({ type: "pres", page: 7, t: 0, playing: false });
ok((await C.wait((m) => m.type === "pres"))?.pres.page === 7, "pres：頁碼 = 頁數、-1、\"4\" 都被丟棄");
// pres：seek 超過 deck 總長或非數字 → 0；剛好等於總長 → 保留
Q.send({ type: "pres", page: 5, t: MAX_SEEK, playing: true });
ok((await C.wait((m) => m.type === "pres"))?.pres.t === MAX_SEEK, "pres：seek = 總長被接受");
Q.send({ type: "pres", page: 5, t: MAX_SEEK + 1, playing: true });
ok((await C.wait((m) => m.type === "pres"))?.pres.t === 0, "pres：seek > 總長歸 0");
Q.send({ type: "pres", page: 5, t: 3000, playing: true });
ok((await C.wait((m) => m.type === "pres"))?.pres.t === 0, "pres：seek 3000（舊上限 3600 以內）歸 0");
Q.send({ type: "pres", page: 5, t: "5", playing: true });
ok((await C.wait((m) => m.type === "pres"))?.pres.t === 0, "pres：字串 seek 歸 0");

// stroke／label.add：deck 以外的頁碼回錯誤且不廣播
let strokeOk = true, labelOk = true;
for (const bp of BAD_PAGES) {
  Q.send({ type: "stroke", page: bp, color: "#f2c14e", w: 4, pts: [1, 1, 2, 2] });
  if (!(await Q.wait((m) => m.type === "error"))) { strokeOk = false; console.log(`  stroke page=${JSON.stringify(bp)} 沒有錯誤`); }
  Q.send({ type: "label.add", page: bp, x: 10, y: 10, text: "越界" });
  if (!(await Q.wait((m) => m.type === "error"))) { labelOk = false; console.log(`  label page=${JSON.stringify(bp)} 沒有錯誤`); }
}
await sleep(200);
ok(strokeOk && !C.inbox.some((m) => m.type === "stroke"), "stroke：頁碼 = 頁數、-1、\"4\" 都被拒");
ok(labelOk && !C.inbox.some((m) => m.type === "label"), "label.add：頁碼 = 頁數、-1、\"4\" 都被拒");
C.send({ type: "stroke", page: 21, color: "#f2c14e", w: 4, pts: [1, 1, 2, 2] });
ok(!!(await C.wait((m) => m.type === "error")), "stroke：學員在動畫頁（最後一頁）畫筆跡被拒");
C.send({ type: "stroke", page: 13, color: "#f2c14e", w: 4, pts: [1, 1, 2, 2] });
ok((await Q.wait((m) => m.type === "stroke"))?.stroke.page === 13, "stroke：學員在討論頁畫筆跡仍可（正向對照）");

// stroke.clear：deck 以外的頁碼被丟棄
for (const bp of BAD_PAGES) Q.send({ type: "stroke.clear", page: bp });
Q.send({ type: "stroke.clear", page: 13 });
ok((await C.wait((m) => m.type === "stroke.clear"))?.page === 13, "stroke.clear：頁碼 = 頁數、-1、\"4\" 都被丟棄");

// vote：非投票的討論頁、動畫頁、字串頁碼、選項數越界都被丟棄
for (const v of [{ page: 13, opt: 0 }, { page: 9, opt: 0 }, { page: 2, opt: 0 }, { page: "4", opt: 0 }, { page: 4, opt: 3 }, { page: 10, opt: 6 }, { page: 4, opt: -1 }, { page: PAGE_COUNT_EXPECTED, opt: 0 }]) C.send({ type: "vote", ...v });
C.send({ type: "vote", page: 10, opt: 5 });
const mv = await C.wait((m) => m.type === "myvote");
ok(mv?.page === 10 && mv.opt === 5, `vote：非投票頁、動畫頁、"4"、選項 = 選項數都被丟棄（第一則 myvote：${JSON.stringify(mv)}）`);
const vc = await Q.wait((m) => m.type === "votes");
ok(vc?.page === 10 && JSON.stringify(vc.counts) === "[0,0,0,0,0,1]", `vote：統計只含合法投票（${JSON.stringify(vc?.counts)}）`);
// vote.reset：非投票頁被丟棄
Q.send({ type: "vote.reset", page: 13 });
Q.send({ type: "vote.reset", page: "10" });
Q.send({ type: "vote.reset", page: 4 });
const vr = await C.wait((m) => m.type === "votes" && m.reset);
ok(vr?.page === 4, "vote.reset：非投票頁與字串頁碼被丟棄");

// note.add：地圖節點／標籤、欄位越界與字串頁碼被拒（驗證失敗不吃留言頻率額度）
clearErrors(C);
const noteCases = [
  [{ page: 9, tag: 8, tag2: 0 }, "地圖節點 = 節點數"],
  [{ page: 9, tag: 0, tag2: 4 }, "地圖標籤 = 標籤數"],
  [{ page: 9, tag: "1", tag2: 0 }, "地圖節點為字串"],
  [{ page: 20, tag: 3 }, "欄位 = 欄數"],
  [{ page: 20, tag: -1 }, "欄位 = -1"],
  [{ page: "13" }, "字串頁碼"],
  [{ page: PAGE_COUNT_EXPECTED }, "頁碼 = 頁數"],
  [{ page: 0 }, "動畫頁"],
];
for (const [m, label] of noteCases) {
  C.send({ type: "note.add", text: "越界測試", ...m });
  ok(!!(await C.wait((x) => x.type === "error")), `note.add：${label}被拒`);
}
await sleep(200);
ok(!Q.inbox.some((m) => m.type === "note"), "note.add：越界留言都沒有廣播");
C.send({ type: "note.add", page: 9, text: "合法地圖留言", tag: 7, tag2: 3 });
const okNote = await Q.wait((m) => m.type === "note");
ok(okNote?.note.tag === 7 && okNote.note.tag2 === 3, "note.add：最後一個節點與標籤可用（正向對照）");

Q.send({ type: "room.end" });
await C.wait((m) => m.type === "ended");
for (const c of [Q, C]) try { c.ws.close(); } catch {}

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
