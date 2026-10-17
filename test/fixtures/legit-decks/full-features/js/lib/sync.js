// 第 1 層：畫面只由 t 決定（冪等），並處理主站送來的 seek（契約 §3 簡報端規則）
import { SEGMENTS, DURATION, clamp, segmentAt } from "./clock.js";

export { DURATION };
let seekCount = 0;

export function render(t) {
  t = clamp(t);
  const { index, local } = segmentAt(t);
  document.getElementById("time").textContent = `${t.toFixed(2)} / ${DURATION.toFixed(2)}`;
  document.getElementById("seg").textContent = `${SEGMENTS[index].title}（${local.toFixed(2)}s）`;
  document.body.dataset.t = String(t);
  document.body.dataset.seg = String(index);
}

export function installSeek(embedded) {
  window.seek = (t) => { seekCount++; render(t); document.body.dataset.seeks = String(seekCount); };
  addEventListener("message", (e) => {
    if (!embedded || e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.ptt !== 1 || m.type !== "seek" || typeof m.t !== "number" || !Number.isFinite(m.t)) return;
    window.seek(m.t);
  });
}
