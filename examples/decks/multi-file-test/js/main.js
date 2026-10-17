import { SEGMENTS, DURATION, clamp, segmentAt } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const timeEl = $("time"), segEl = $("seg"), barEl = $("bar"), statusEl = $("status");
let seekCount = 0;

// 畫面只由 t 決定（冪等）
function render(t) {
  t = clamp(t);
  const { index, local } = segmentAt(t);
  timeEl.textContent = `${t.toFixed(2)} / ${DURATION.toFixed(2)}`;
  segEl.textContent = `${SEGMENTS[index].title}（${local.toFixed(2)}s）`;
  barEl.style.width = `${(t / DURATION) * 100}%`;
  document.body.dataset.t = String(t);
  document.body.dataset.seg = String(index);
}

window.DURATION = DURATION;
window.seek = (t) => { seekCount++; render(t); document.body.dataset.seeks = String(seekCount); };

// 載入檢查：字型與圖片就緒後才送 ready
async function loadAll() {
  const fontOk = await document.fonts.load('16px "Plex Mono Test"').then((f) => f.length > 0, () => false);
  const img = $("mark");
  const imgOk = await (img.decode ? img.decode().then(() => true, () => false) : Promise.resolve(true));
  document.body.dataset.module = "ok";
  document.body.dataset.font = fontOk ? "ok" : "fail";
  document.body.dataset.img = imgOk ? "ok" : "fail";
  statusEl.textContent = `module=ok font=${fontOk ? "ok" : "fail"} img=${imgOk ? "ok" : "fail"}`;
}

const embedded = window.parent !== window;

// 契約 v1 §3（簡報端規則）：只收來自 window.parent 的 seek，並檢查 ptt／type／t
addEventListener("message", (e) => {
  if (!embedded || e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.ptt !== 1 || m.type !== "seek" || typeof m.t !== "number" || !Number.isFinite(m.t)) return;
  window.seek(m.t);
});

const qt = parseFloat(new URLSearchParams(location.search).get("t"));
render(Number.isFinite(qt) ? qt : 0);

window.ready = loadAll();
window.ready.then(() => {
  if (embedded) parent.postMessage({ ptt: 1, type: "ready", duration: DURATION }, "*");
});
