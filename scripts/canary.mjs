// S4-B 本機收件端（canary）：一個 HTTP 伺服器與一個 UDP socket，記錄任何打進來的命中。
// 惡意樣本把「對外送資料」的目標一律指向這裡（而不是沒有監聽的埠），這樣「被擋下＝0 命中」才是真的被擋，
// 而不是連線本來就失敗。HTTP 端對所有請求回 200、CORS *，並依副檔名給對應 Content-Type，
// 讓 fetch／img／script／style／font／beacon／prefetch 等都能「成功」而留下命中紀錄（用於對照組證明偵測有效）。
// UDP 端收 WebRTC STUN 等封包（M14 量測）。只在本機 127.0.0.1 監聽；不對外、不解析使用者輸入為指令。
import http from "node:http";
import dgram from "node:dgram";

const TYPE_BY_EXT = new Map([
  ["js", "text/javascript; charset=utf-8"], ["css", "text/css; charset=utf-8"],
  ["png", "image/png"], ["jpg", "image/jpeg"], ["gif", "image/gif"], ["svg", "image/svg+xml"],
  ["woff2", "font/woff2"], ["woff", "font/woff"], ["json", "application/json; charset=utf-8"],
  ["html", "text/html; charset=utf-8"],
]);
// 1x1 透明 PNG，讓 img 命中能真的「載入成功」
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function typeFor(pathname) {
  const dot = pathname.lastIndexOf(".");
  const ext = dot >= 0 ? pathname.slice(dot + 1).toLowerCase() : "";
  return { ext, type: TYPE_BY_EXT.get(ext) || "text/plain; charset=utf-8" };
}

/**
 * 啟動收件端。回傳 { httpOrigin, httpPort, udpPort, hits, reset, stop }。
 * hits = { http: [{method, url, referer, origin, at}], udp: [{bytes, from, at}] }。
 */
export async function startCanary({ httpPort = 8873, udpPort = 8874, host = "127.0.0.1" } = {}) {
  const hits = { http: [], udp: [] };
  const log = (typeof process !== "undefined" && process.env.CANARY_LOG === "1");

  const server = http.createServer((req, res) => {
    const rec = { method: req.method, url: req.url, referer: req.headers.referer || "", origin: req.headers.origin || "", at: Date.now() };
    hits.http.push(rec);
    if (log) console.log(`HTTP  ${rec.method} ${rec.url}  referer=${rec.referer} origin=${rec.origin}`);
    const { ext, type } = typeFor((req.url || "").split("?")[0]);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", type);
    res.statusCode = 200;
    if (ext === "png" || ext === "jpg" || ext === "gif") return res.end(PNG_1x1);
    if (ext === "js") return res.end("window.__m06script=1;\n");
    if (ext === "css") return res.end(":root{--canary:1}\n");
    if (ext === "json") return res.end('{"canary":1}');
    res.end("canary");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(httpPort, host, resolve); });

  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, rinfo) => {
    const rec = { bytes: msg.length, from: `${rinfo.address}:${rinfo.port}`, at: Date.now() };
    hits.udp.push(rec);
    if (log) console.log(`UDP   ${rec.bytes} bytes from ${rec.from}`);
  });
  await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(udpPort, host, resolve); });

  return {
    httpOrigin: `http://${host}:${httpPort}`,
    httpPort, udpPort, hits,
    reset() { hits.http.length = 0; hits.udp.length = 0; },
    stop() { try { server.close(); } catch {} try { udp.close(); } catch {} },
  };
}

// 直接執行：啟動並持續記錄命中，直到 Ctrl+C。
if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  process.env.CANARY_LOG = "1";
  const httpPort = Number(process.argv[2]) || 8873, udpPort = Number(process.argv[3]) || 8874;
  const c = await startCanary({ httpPort, udpPort });
  console.log(`收件端已啟動：HTTP ${c.httpOrigin}、UDP 127.0.0.1:${c.udpPort}（Ctrl+C 結束）`);
  process.on("SIGINT", () => { c.stop(); process.exit(0); });
}
