// 開始上傳驗證路徑的 CPU 微基準（S3c-1 的 CPU 替代證據）：直接 import src/deck-upload.js 與 src/deck.js（不需 loader 或 mock）。
// 最壞情況輸入：接近 128 KiB 的合法 deck.json（100 頁、長文字、html 頁）＋300 項清單（長路徑、深度 8）。
// 量 validateBeginBody（本體 JSON.parse → deck.json 位元組上限 → parseDeckText 一次 → 清單）與 checkQuota。
// 門檻：中位數 ≤ 3 ms。注意：這是本機 Node 的數字，不等於 Workers 正式環境的 CPU 計時（部署後以 Workers Observability 確認）。
// 用法：node scripts/bench-begin.mjs [次數，預設 300]
import { validateBeginBody, checkQuota, utf8ByteLength, UPLOAD_LIMITS } from "../src/deck-upload.js";

const RUNS = Number(process.argv[2]) || 300;
const WARMUP = 50;
const LIMIT_MS = 3;

// ---- 最壞情況 deck.json：timeline、100 段、100 頁（含 99 個 html 頁與討論頁），以 ASCII 長文字補到接近 128 KiB ----
function buildDeck(textLen) {
  const segments = Array.from({ length: 100 }, (_, i) => ({ group: `G${i % 10}`, title: `段落 ${i}`.padEnd(20, "x"), duration: 60 }));
  const pages = [];
  for (let i = 0; i < 100; i++) {
    if (i === 0) pages.push({ type: "anim", seg: 0, text: "t".repeat(textLen) });
    else if (i % 10 === 5) pages.push({ type: "disc", kind: "map", kicker: "k", title: "討論".padEnd(60, "y"), prompt: "p".repeat(150), text: "d".repeat(textLen), nodes: Array.from({ length: 12 }, (_, j) => `節點${j}`.padEnd(30, "n")), tags: Array.from({ length: 6 }, (_, j) => ({ label: `標籤${j}`, color: "#a1b2c3" })) });
    else pages.push({ type: "html", path: `slides/s${String(i).padStart(3, "0")}/` + "a/b/c/d/e/".slice(0, 10) + `p${i}.html`, title: "頁".padEnd(30, "z"), text: "h".repeat(textLen) });
  }
  return { contract: 1, id: "bench-worst-case", title: "最壞情況基準簡報", version: "1.0.0", entry: "index.html", runtime: "timeline", segments, pages };
}
let lo = 0, hi = 2000, deckText = "";
while (lo < hi) { // 找出不超過 128 KiB（UTF-8 位元組）的最長文字
  const mid = Math.ceil((lo + hi) / 2);
  const t = JSON.stringify(buildDeck(mid));
  if (utf8ByteLength(t) <= UPLOAD_LIMITS.deckBytes) { lo = mid; deckText = t; } else hi = mid - 1;
}
const deck = JSON.parse(deckText);

// ---- 300 項清單：entry＋所有 html 頁，其餘補長路徑（深度 8、長度接近 200）----
const files = [{ path: "index.html", size: 1024, sha256: "a".repeat(64) }];
for (const pg of deck.pages) if (pg.type === "html") files.push({ path: pg.path, size: 4096, sha256: "b".repeat(64) });
for (let i = files.length; i < UPLOAD_LIMITS.filesMax; i++) {
  const base = `assets/l1/l2/l3/l4/l5/l6/f${String(i).padStart(4, "0")}-`;
  files.push({ path: base + "q".repeat(200 - base.length - 4) + ".png", size: 100000, sha256: "c".repeat(64) });
}
const body = JSON.stringify({ deck: deckText, files });

const check = validateBeginBody(body);
if (!check.ok) { console.error("最壞情況輸入未通過驗證：", check); process.exit(2); }
console.log(`輸入：deck.json ${utf8ByteLength(deckText)} 位元組（上限 ${UPLOAD_LIMITS.deckBytes}）、${deck.pages.length} 頁、清單 ${files.length} 項、本體 ${utf8ByteLength(body)} 位元組`);

const usage = { pendingByUploader: 1, pendingGlobal: 4, bytesInUse: 4 * 1024 ** 3, liveDecks: 199 };
const times = [];
for (let i = 0; i < WARMUP + RUNS; i++) {
  const t0 = process.hrtime.bigint();
  const r = validateBeginBody(body);
  const q = checkQuota(usage, r.totalBytes);
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!r.ok || !q.ok) { console.error("基準過程中驗證失敗"); process.exit(2); }
  if (i >= WARMUP) times.push(dt);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
const median = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
console.log(`次數 ${RUNS}（暖機 ${WARMUP}）：中位數 ${median.toFixed(3)} ms、p90 ${pct(0.9).toFixed(3)} ms、p99 ${pct(0.99).toFixed(3)} ms、最大 ${times[times.length - 1].toFixed(3)} ms；Node ${process.version}`);
const pass = median <= LIMIT_MS;
console.log(pass ? `PASS  中位數 ≤ ${LIMIT_MS} ms` : `FAIL  中位數超過 ${LIMIT_MS} ms`);
process.exit(pass ? 0 : 1);
