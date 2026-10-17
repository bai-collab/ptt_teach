// S8 單頁 AI 問答冒煙測試：用假的 NMKING 驗證 POST /api/rooms/:code/ask。
// 自己啟動 wrangler dev 實例並記錄 PID，測完只關自己的程序樹（taskkill /T）；不碰 8791／8801／8802 與其他測試埠。
//   - 主站 A  127.0.0.1:8851  NMKING_API_KEY=test-key、NMKING_ENDPOINT 指向假伺服器（只在 development＋迴環主機名生效）
//   - 主站 B  127.0.0.1:8853  NMKING_API_KEY 為空（驗證 503）
//   - 假 NMKING 127.0.0.1:8852（node:http，回 Responses API SSE）
// 用法：node scripts/smoke-ask.mjs
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { req, sleep, root, ADMIN } from "./smoke-deckhost.mjs";

const MAIN_A = 8851, FAKE = 8852, MAIN_B = 8853;
const KEY = "test-key-smoke-ask";
const ANSWER = "**Teachers first** 指的是：\n\n- 教師先行\n- 科技不會自己改變教育";
const wranglerJs = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => { if (ok) passed++; else failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  ← " + detail}`); };

const portBusy = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.on("connect", () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

// ---- 假 NMKING ----
const seen = [];
const fake = http.createServer((rq, rs) => {
  const chunks = [];
  rq.on("data", (d) => chunks.push(d));
  rq.on("end", () => {
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    seen.push({ auth: rq.headers.authorization, path: rq.url, body });
    const user = body?.input?.[0]?.content?.[0]?.text || "";
    if (user.includes("__FAIL__")) { rs.writeHead(500, { "content-type": "text/plain" }); rs.end("upstream-secret-detail"); return; }
    rs.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (o) => rs.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    const half = Math.floor(ANSWER.length / 2);
    ev({ type: "response.output_text.delta", delta: ANSWER.slice(0, half) });
    ev({ type: "response.output_text.delta", delta: ANSWER.slice(half) });
    ev({ type: "response.completed", response: { status: "completed", model: body?.model, usage: { output_tokens: 42 }, output: [{ type: "message", content: [{ type: "output_text", text: ANSWER }] }] } });
    rs.end("data: [DONE]\n\n");
  });
});

function startMain(port, tag, extraVars) {
  const persist = `.wrangler/${tag}`;
  const registry = join(root, ".wrangler", `registry-${tag}`);
  for (const d of [join(root, persist), registry]) rmSync(d, { recursive: true, force: true });
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_REGISTRY_PATH: registry };
  const args = [wranglerJs, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persist,
    "--var", "ENVIRONMENT:development", "--var", "DEV_LOGIN:1", "--var", `ADMIN_EMAILS:${ADMIN}`,
    "--var", `NMKING_ENDPOINT:http://127.0.0.1:${FAKE}/v1/responses`, ...extraVars.flatMap((v) => ["--var", v])];
  const p = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  p.log = () => log;
  return p;
}
const killTree = (p) => { if (p?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(p.pid)], { stdio: "ignore" }); };

async function waitUp(base, p) {
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const r = await req(base, "/api/health");
    if (r.data?.app === "ptt-teach") return;
  }
  throw new Error(`實例未就緒 ${base}\n${p.log().slice(-800)}`);
}
async function login(base) {
  const r = await req(base, "/api/dev/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: { email: ADMIN } });
  if (r.status !== 200) throw new Error(`登入失敗 ${r.status} ${r.text}`);
  return String(r.headers["set-cookie"][0]).split(";")[0];
}
async function newRoom(base, cookie) {
  const r = await req(base, "/api/rooms", { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: {} });
  if (r.status !== 200 || !r.data?.code) throw new Error(`建場失敗 ${r.status} ${r.text}`);
  return r.data.code;
}
const ask = (base, code, body, origin = base) =>
  req(base, `/api/rooms/${code}/ask`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body });

const procs = [];
try {
  for (const p of [MAIN_A, FAKE, MAIN_B]) if (await portBusy(p)) throw new Error(`${p} 埠已被其他程序使用（不會關閉別人的程序）`);
  await new Promise((r) => fake.listen(FAKE, "127.0.0.1", r));
  const A = `http://127.0.0.1:${MAIN_A}`, B = `http://127.0.0.1:${MAIN_B}`;
  procs.push(startMain(MAIN_A, "smoke-ask-a", [`NMKING_API_KEY:${KEY}`]));
  procs.push(startMain(MAIN_B, "smoke-ask-b", ["NMKING_API_KEY:"]));
  console.log(`PID：A=${procs[0].pid} B=${procs[1].pid}`);
  await waitUp(A, procs[0]);
  await waitUp(B, procs[1]);

  const ca = await login(A);
  const code = await newRoom(A, ca);
  // 內建範例：第 3 頁（index 2）是有 text 的動畫頁；第 5 頁（index 4）是沒有 text 的討論頁
  const Q = "Teachers first 是什麼意思？SMOKE-Q-7f3a";

  // 1. 正常回答
  let r = await ask(A, code, { page: 2, question: Q, pid: "smokepid0001" });
  check("正常回答 200", r.status === 200, `${r.status} ${r.text}`);
  check("回答內容來自上游（未被改寫）", r.data?.answer === ANSWER, r.text);
  const up = seen.at(-1);
  check("上游收到正確金鑰", up?.auth === `Bearer ${KEY}`);
  check("上游使用預設模型 openai/gpt-5.6-luna", up?.body?.model === "openai/gpt-5.6-luna", up?.body?.model);
  const sentUser = up?.body?.input?.[0]?.content?.[0]?.text || "";
  check("上游提示含該頁 text 與問題", sentUser.includes("Teachers first，科技不會自己改變教育") && sentUser.includes("SMOKE-Q-7f3a"), sentUser.slice(0, 200));
  check("系統提示要求以本頁為主軸解釋、不可只回沒有定義", String(up?.body?.instructions || "").includes("把這一頁看懂") && String(up?.body?.instructions || "").includes("不要回答「這一頁沒有定義"));
  check("串流模式且不儲存", up?.body?.stream === true && up?.body?.store === false);

  // 2. 沒有 text 的頁 404
  const before = seen.length;
  r = await ask(A, code, { page: 4, question: "這頁在問什麼？", pid: "smokepid0002" });
  check("沒有 text 的頁 404", r.status === 404 && r.data?.error === "這一頁不開放提問", `${r.status} ${r.text}`);
  // 3. 題目長度
  r = await ask(A, code, { page: 2, question: "問".repeat(301), pid: "smokepid0002" });
  check("題目 301 字 400", r.status === 400, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: "問".repeat(300), pid: "smokepid0009" });
  check("題目 300 字可送出", r.status === 200, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: "   ", pid: "smokepid0002" });
  check("空白題目 400", r.status === 400, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: 123, pid: "smokepid0002" });
  check("題目不是字串 400", r.status === 400, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 99, question: "頁碼超出", pid: "smokepid0002" });
  check("頁碼超出範圍 400", r.status === 400, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: "2", question: "頁碼是字串", pid: "smokepid0002" });
  check("頁碼不是整數 400", r.status === 400, `${r.status} ${r.text}`);
  check("被拒的請求沒有呼叫上游", seen.length === before + 1, `上游呼叫 ${seen.length - before} 次（應只有 300 字那 1 次）`);
  // 4. 跨 Origin
  r = await ask(A, code, { page: 2, question: Q, pid: "smokepid0003" }, "http://evil.example");
  check("跨 Origin 403", r.status === 403, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: Q, pid: "smokepid0003" }, "http://127.0.0.1:8802");
  check("簡報主機 Origin 403", r.status === 403, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: Q, pid: "smokepid0003" }, null);
  check("沒有 Origin 403", r.status === 403, `${r.status} ${r.text}`);
  r = await req(A, `/api/rooms/${code}/ask`, { headers: { origin: A } });
  check("GET 404", r.status === 404, `${r.status}`);
  r = await ask(A, "ZZZZZZ", { page: 2, question: Q, pid: "smokepid0003" });
  check("不存在的場次 404", r.status === 404, `${r.status} ${r.text}`);
  // 5. 上游錯誤不外洩原文
  r = await ask(A, code, { page: 2, question: "__FAIL__", pid: "smokepid0004" });
  check("上游 500 → 502", r.status === 502, `${r.status} ${r.text}`);
  check("錯誤訊息不含上游原文", !r.text.includes("upstream-secret-detail"), r.text);
  // 6. 每人每分鐘 3 次（smokepid0001 已用 1 次）
  const s1 = (await ask(A, code, { page: 2, question: "第二次", pid: "smokepid0001" })).status;
  const s2 = (await ask(A, code, { page: 2, question: "第三次", pid: "smokepid0001" })).status;
  r = await ask(A, code, { page: 2, question: "第四次", pid: "smokepid0001" });
  check("同一人第 2、3 次 200", s1 === 200 && s2 === 200, `${s1} ${s2}`);
  check("同一人第 4 次 429", r.status === 429, `${r.status} ${r.text}`);
  r = await ask(A, code, { page: 2, question: "換一個人", pid: "smokepid0005" });
  check("另一人不受影響 200", r.status === 200, `${r.status} ${r.text}`);
  // 7. 每場 300 次：用不同 pid 持續提問，直到被擋
  let ok = 0, firstBlock = null;
  for (let i = 0; i < 320 && firstBlock === null; i++) {
    const x = await ask(A, code, { page: 2, question: "總量", pid: `bulkpid${String(i).padStart(4, "0")}` });
    if (x.status === 200) ok++; else firstBlock = x;
  }
  check("每場上限 300 次後 429", firstBlock?.status === 429 && /用完/.test(firstBlock?.data?.error || ""), firstBlock ? `${firstBlock.status} ${firstBlock.text}` : "沒有被擋");
  // 前面已成功扣額度：1+1(300字)+1(500 也扣)+2+1 = 6 次
  check("總量上限正好 300", ok + 6 === 300, `批次成功 ${ok}，加上先前 6 次 = ${ok + 6}`);
  // 新場次重新計數
  const code2 = await newRoom(A, ca);
  r = await ask(A, code2, { page: 2, question: Q, pid: "smokepid0001" });
  check("新場次重新計數 200", r.status === 200, `${r.status} ${r.text}`);
  // 8. 沒有金鑰 503
  const cb = await login(B);
  const codeB = await newRoom(B, cb);
  const beforeB = seen.length;
  r = await ask(B, codeB, { page: 2, question: Q, pid: "smokepid0006" });
  check("沒有金鑰 503", r.status === 503 && r.data?.error === "AI 問答未設定", `${r.status} ${r.text}`);
  check("沒有金鑰時不呼叫上游", seen.length === beforeB);
  r = await ask(B, codeB, { page: 4, question: Q, pid: "smokepid0006" });
  check("沒有金鑰時，沒有 text 的頁仍回 404", r.status === 404, `${r.status}`);
  // 9. 管理者在網頁設定金鑰（B 沒有環境變數金鑰）
  const KEY2 = "admin-web-key-smoke-9c1e";
  const aiReq = (method, cookie, body, origin = B) => req(B, "/api/admin/ai", { method, headers: { "content-type": "application/json", cookie, ...(origin ? { origin } : {}) }, ...(body ? { body } : {}) });
  r = await aiReq("GET", cb);
  check("管理者 GET 設定：未設定", r.status === 200 && r.data?.configured === false && r.data?.model === "openai/gpt-5.6-luna", r.text);
  r = await aiReq("PUT", cb, { key: KEY2 }, "http://evil.example");
  check("跨 Origin 寫入金鑰 403", r.status === 403, `${r.status}`);
  r = await aiReq("PUT", cb, { key: KEY2 }, null);
  check("沒有 Origin 寫入金鑰 403", r.status === 403, `${r.status}`);
  r = await aiReq("PUT", cb, { key: "has space key" });
  check("金鑰格式不合 400", r.status === 400, `${r.status} ${r.text}`);
  r = await aiReq("PUT", cb, { key: "" });
  check("尚無金鑰時空白金鑰 400", r.status === 400, `${r.status} ${r.text}`);
  r = await aiReq("PUT", cb, { key: KEY2, model: "bad model!" });
  check("模型名稱不合 400", r.status === 400, `${r.status} ${r.text}`);
  // 講師（非管理者）不可讀寫
  await req(B, "/api/admin/presenters", { method: "POST", headers: { "content-type": "application/json", cookie: cb, origin: B }, body: { email: "teacher@example.test" } });
  const tl = await req(B, "/api/dev/login", { method: "POST", headers: { "content-type": "application/json", origin: B }, body: { email: "teacher@example.test" } });
  const ct = String(tl.headers["set-cookie"]?.[0] || "").split(";")[0];
  check("講師可登入（前置）", tl.status === 200 && !!ct, `${tl.status}`);
  r = await aiReq("GET", ct);
  check("講師 GET 設定 403", r.status === 403, `${r.status}`);
  r = await aiReq("PUT", ct, { key: KEY2 });
  check("講師寫入金鑰 403", r.status === 403, `${r.status}`);
  r = await aiReq("GET", "");
  check("未登入 GET 設定 403", r.status === 403, `${r.status}`);
  // 正常寫入
  r = await aiReq("PUT", cb, { key: KEY2, model: "openai/test-model-1" });
  check("管理者寫入金鑰 200", r.status === 200 && r.data?.configured === true && r.data?.source === "admin" && r.data?.last4 === KEY2.slice(-4) && r.data?.model === "openai/test-model-1", r.text);
  check("寫入回應不含金鑰本身", !r.text.includes(KEY2));
  r = await aiReq("GET", cb);
  check("GET 設定不含金鑰本身", r.status === 200 && !r.text.includes(KEY2) && r.data?.updatedBy === ADMIN, r.text);
  const beforeW = seen.length;
  r = await ask(B, codeB, { page: 2, question: Q, pid: "smokepid0007" });
  check("網頁設定金鑰後可提問 200", r.status === 200 && r.data?.answer === ANSWER, `${r.status} ${r.text}`);
  check("上游收到網頁設定的金鑰與模型", seen.length === beforeW + 1 && seen.at(-1)?.auth === `Bearer ${KEY2}` && seen.at(-1)?.body?.model === "openai/test-model-1", JSON.stringify(seen.at(-1)?.body?.model));
  // 只改模型、保留金鑰
  r = await aiReq("PUT", cb, { key: "", model: "openai/test-model-2" });
  check("只改模型保留金鑰", r.status === 200 && r.data?.configured === true && r.data?.model === "openai/test-model-2" && r.data?.last4 === KEY2.slice(-4), r.text);
  // A：網頁設定優先於環境變數
  r = await req(A, "/api/admin/ai", { method: "PUT", headers: { "content-type": "application/json", cookie: ca, origin: A }, body: { key: KEY2 } });
  check("A 管理者寫入金鑰 200", r.status === 200 && r.data?.source === "admin", r.text);
  r = await ask(A, code2, { page: 2, question: Q, pid: "smokepid0008" });
  check("網頁設定優先於環境變數", r.status === 200 && seen.at(-1)?.auth === `Bearer ${KEY2}`, `${r.status} ${seen.at(-1)?.auth === `Bearer ${KEY}` ? "用了環境變數金鑰" : ""}`);
  r = await req(A, "/api/admin/ai", { method: "DELETE", headers: { cookie: ca, origin: A } });
  check("A 清除後退回環境變數", r.status === 200 && r.data?.source === "env", r.text);
  // 清除
  r = await aiReq("DELETE", cb, null, "http://evil.example");
  check("跨 Origin 清除 403", r.status === 403, `${r.status}`);
  r = await aiReq("DELETE", cb);
  check("管理者清除 200", r.status === 200 && r.data?.configured === false, r.text);
  r = await ask(B, codeB, { page: 2, question: Q, pid: "smokepid0010" });
  check("清除後提問 503", r.status === 503, `${r.status} ${r.text}`);

  // 10. log 不含提問、回答與金鑰
  await sleep(500);
  const logA = procs[0].log();
  check("log 不含提問原文", !logA.includes("SMOKE-Q-7f3a"));
  check("log 不含回答", !logA.includes("科技不會自己改變教育") && !logA.includes("教師先行"));
  check("log 不含金鑰", !logA.includes(KEY) && !logA.includes(KEY2) && !procs[1].log().includes(KEY2));
} catch (e) {
  failed++;
  console.log("FAIL  執行錯誤：" + (e?.stack || e));
} finally {
  for (const p of procs) killTree(p);
  fake.close();
}
console.log(`\nsmoke-ask：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
