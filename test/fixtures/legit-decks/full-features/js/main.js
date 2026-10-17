// 合格功能樣本（S4-A）：兩層 module 鏈 main.js → lib/sync.js → lib/clock.js；
// 載入檢查：fetch 自己的 JSON、data: 圖片、data: 字型、mp3、mp4。全部就緒後依契約 §3 送 ready。
import { DURATION, render, installSeek } from "./lib/sync.js";

const $ = (id) => document.getElementById(id);
const media = (el) => new Promise((resolve) => {
  if (el.readyState >= 1) return resolve(el.duration > 0 ? "ok" : "fail");
  el.addEventListener("loadedmetadata", () => resolve(el.duration > 0 ? "ok" : "fail"), { once: true });
  el.addEventListener("error", () => resolve("fail"), { once: true });
  setTimeout(() => resolve("timeout"), 8000);
});

async function loadAll() {
  const out = { module: "ok" };
  try {
    const info = await (await fetch("data/info.json")).json();
    out.json = info && info.deck === "full-features-test" ? "ok" : "bad";
  } catch (e) { out.json = "fail:" + e.name; }
  const img = $("dataimg");
  out.dataimg = await (img.decode ? img.decode().then(() => (img.naturalWidth > 0 ? "ok" : "fail"), () => "fail") : Promise.resolve("ok"));
  out.datafont = await document.fonts.load('16px "FF Data Mono"').then((f) => (f.length > 0 ? "ok" : "fail"), () => "fail");
  out.audio = await media($("audio"));
  out.video = await media($("video"));
  for (const [k, v] of Object.entries(out)) document.body.dataset[k] = v;
  $("status").textContent = Object.entries(out).map(([k, v]) => `${k}=${v}`).join(" ");
}

// 播放檢查（測試用）：播放後 currentTime 前進即為可播放
window.__ffPlay = async () => {
  const res = {};
  for (const id of ["audio", "video"]) {
    const el = $(id);
    try {
      el.currentTime = 0;
      await el.play();
      await new Promise((r) => setTimeout(r, 400));
      res[id] = el.currentTime > 0 ? "playing" : "stalled";
      el.pause();
    } catch (e) { res[id] = "error:" + e.name; }
  }
  return res;
};

const embedded = window.parent !== window;
installSeek(embedded);
const qt = parseFloat(new URLSearchParams(location.search).get("t"));
render(Number.isFinite(qt) ? qt : 0);
window.DURATION = DURATION;
window.ready = loadAll();
window.ready.then(() => {
  if (embedded) parent.postMessage({ ptt: 1, type: "ready", duration: DURATION }, "*");
});
