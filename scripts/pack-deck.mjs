// 簡報包打包腳本（S3d-A）：把簡報資料夾打成 deck.zip，供測試與上傳流程使用。
// 用法：node scripts/pack-deck.mjs <deckDir> [outZip]
//   - 預設輸出 dist/<deck.id>-<version>.zip（dist/ 已被 .gitignore 忽略）。
//   - 零相依：zip 由本檔以 node:zlib 的 deflateRawSync 組成（壓縮後較大就改用 store）。
//   - 輸出確定（deterministic）：路徑依 UTF-16 碼位排序、固定時間戳（1980-01-01）、無額外欄位。
//   - 略過任何路徑段以 "." 開頭的檔案或資料夾（dotfile）；遇到符號連結直接報錯。
//   - 寫檔前以 src/deck.js 與 src/deck-upload.js 的同一套規則驗證（與伺服器「開始上傳」相同的 validateBeginBody）；
//     任何錯誤都不會產生 zip。
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { validateBeginBody } from "../src/deck-upload.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function die(msg) {
  console.error(`pack-deck: ${msg}`);
  process.exit(1);
}

// ---- CRC-32 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 蒐集檔案（遞迴、略過 dotfile、依路徑排序）----
function collect(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) die(`不支援符號連結：${relative(dir, full).split(sep).join("/")}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.push({ path: relative(dir, full).split(sep).join("/"), data: readFileSync(full) });
    }
  };
  walk(dir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// ---- 組 zip ----
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, "ascii"); // 路徑已通過 ASCII 白名單
    const raw = e.data;
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- main ----
const [deckArg, outArg] = process.argv.slice(2);
if (!deckArg) die("用法：node scripts/pack-deck.mjs <deckDir> [outZip]");
const deckDir = resolve(deckArg);
if (!existsSync(deckDir) || !lstatSync(deckDir).isDirectory()) die(`找不到資料夾：${deckArg}`);

const all = collect(deckDir);
const deckEntry = all.find((e) => e.path === "deck.json");
if (!deckEntry) die("資料夾缺少 deck.json");
const deckText = deckEntry.data.toString("utf8");
const others = all.filter((e) => e.path !== "deck.json");

// 與伺服器「開始上傳」相同的驗證：deck.json 結構、清單路徑與副檔名、大小、entry 與 html 頁存在
const manifest = others.map((e) => ({ path: e.path, size: e.data.length, sha256: createHash("sha256").update(e.data).digest("hex") }));
const v = validateBeginBody(JSON.stringify({ deck: deckText, files: manifest }));
if (!v.ok) {
  console.error(`pack-deck: 驗證失敗：${v.error}（${v.code}，${v.path}）`);
  for (const e of v.errors || []) console.error(`  ${e.path}  ${e.code}  ${e.message}`);
  process.exit(1);
}

const deck = v.deck;
const outPath = outArg ? resolve(outArg) : join(root, "dist", `${deck.id}-${deck.version}.zip`);
mkdirSync(dirname(outPath), { recursive: true });
const zip = buildZip([deckEntry, ...others]);
writeFileSync(outPath, zip);
console.log(`pack-deck: ${deck.id}@${deck.version} 共 ${others.length + 1} 個檔（含 deck.json），${zip.length} 位元組`);
console.log(`pack-deck: sha256=${createHash("sha256").update(zip).digest("hex")}`);
console.log(`pack-deck: 已寫入 ${outPath}`);
