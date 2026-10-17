// 內建簡報建置（方案 B：不使用 R2，簡報隨簡報主機一起部署）。
// 來源：builtin-decks/<資料夾>/（每份一個資料夾，最上層有 deck.json）。
// 產出（都會 commit，部署與測試直接使用）：
//   1. src/builtin-decks.generated.js：兩個 Worker 共用的清單（代號、id、版本、標題、驗證後的 deck JSON、允許的檔案路徑與雜湊）
//   2. wrangler.production.toml、deck-host/wrangler.production.toml：由一般設定移除 [[r2_buckets]] 區塊而來的正式部署設定
// 驗證與網頁上傳完全相同（src/deck-upload.js 的 validateBeginBody：deck.json 契約、路徑白名單、副檔名、大小與檔數上限、entry／html 頁存在）。
// 代號＝sha256("builtin:" + id + "@" + version) 前 32 位 hex（與上傳代號同格式，live 頁網址格式不變）。
// 用法：
//   node scripts/build-builtin-decks.mjs          重新產生
//   node scripts/build-builtin-decks.mjs --check  只檢查產出是否與來源一致（不寫檔；不一致時結束碼 1）
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBeginBody, UPLOAD_LIMITS } from "../src/deck-upload.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "builtin-decks");
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const check = process.argv.includes("--check");
const fail = (msg) => { console.error("錯誤：" + msg); process.exit(1); };

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.filter((p) => p !== "deck.json");
}

const decks = [];
const seen = new Map();
if (!existsSync(SRC)) fail("找不到 builtin-decks/ 資料夾");
const folders = readdirSync(SRC).filter((n) => statSync(join(SRC, n)).isDirectory()).sort();
if (folders.length > UPLOAD_LIMITS.decksMax) fail(`內建簡報最多 ${UPLOAD_LIMITS.decksMax} 份`);
for (const folder of folders) {
  if (!FOLDER_RE.test(folder)) fail(`資料夾名稱只能用小寫英數與 -（最多 48 字）：${folder}`);
  const dir = join(SRC, folder);
  if (!existsSync(join(dir, "deck.json"))) fail(`${folder}/ 缺少 deck.json`);
  const deckText = readFileSync(join(dir, "deck.json"), "utf8");
  const files = listFiles(dir).map((path) => { const b = readFileSync(join(dir, path)); return { path, size: b.length, sha256: sha(b) }; });
  const v = validateBeginBody(JSON.stringify({ deck: deckText, files }));
  if (!v.ok) fail(`${folder}：${v.error}（${v.path}）${v.errors ? " " + JSON.stringify(v.errors.slice(0, 3)) : ""}`);
  const key = `${v.deck.id}@${v.deck.version}`;
  if (seen.has(key)) fail(`${folder} 與 ${seen.get(key)} 的 id＋version 重複：${key}`);
  seen.set(key, folder);
  decks.push({
    uploadId: sha(`builtin:${key}`).slice(0, 32),
    folder,
    id: v.deck.id,
    version: v.deck.version,
    title: typeof v.deck.title === "string" ? v.deck.title : "",
    deckJson: v.deckJson,
    files: v.files.map((f) => [f.path, f.sha256]),
  });
}

const moduleText = [
  "// 自動產生：node scripts/build-builtin-decks.mjs（來源 builtin-decks/）。請勿手動修改。",
  "// 內建簡報清單：主站用來列出與建場；簡報主機只放行這裡登記的代號＋路徑（其餘一律 404）。",
  `export const BUILTIN_DECKS = Object.freeze(${JSON.stringify(decks, null, 2)}.map((d) => Object.freeze({ ...d, files: new Map(d.files) })));`,
  "export const BUILTIN_BY_UPLOAD_ID = new Map(BUILTIN_DECKS.map((d) => [d.uploadId, d]));",
  "export const builtinDeckFor = (id, version) => BUILTIN_DECKS.find((d) => d.id === id && d.version === version) || null;",
  "",
].join("\n");

// 正式部署設定：一般設定去掉 [[r2_buckets]] 區塊（到下一個空行或下一個表頭為止）
function stripR2(text, note) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "[[r2_buckets]]") {
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].trim().startsWith("[")) i++;
      i--;
      continue;
    }
    out.push(lines[i]);
  }
  const body = out.join("\n");
  if (/r2_buckets|bucket_name/.test(body)) fail("移除 R2 區塊失敗");
  return `# 自動產生：node scripts/build-builtin-decks.mjs（來源 ${note}）。請勿手動修改。\n# 正式部署（方案 B：不使用 R2，簡報上傳停用，只提供內建簡報）。\n${body}`;
}
const outputs = [
  [join(root, "src", "builtin-decks.generated.js"), moduleText],
  [join(root, "wrangler.production.toml"), stripR2(readFileSync(join(root, "wrangler.toml"), "utf8"), "wrangler.toml")],
  [join(root, "deck-host", "wrangler.production.toml"), stripR2(readFileSync(join(root, "deck-host", "wrangler.toml"), "utf8"), "deck-host/wrangler.toml")],
];

let stale = 0;
for (const [file, text] of outputs) {
  const cur = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
  if (cur === text) continue;
  stale++;
  if (check) console.error(`不一致：${relative(root, file)}（請執行 node scripts/build-builtin-decks.mjs）`);
  else writeFileSync(file, text);
}
for (const d of decks) console.log(`內建簡報：${d.id}@${d.version}｜${d.title}｜${d.files.length} 個檔案｜代號 ${d.uploadId}`);
if (check) { if (stale) process.exit(1); console.log("產出與來源一致"); }
else console.log(stale ? `已更新 ${stale} 個產出檔` : "產出已是最新");
