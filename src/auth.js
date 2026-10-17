// 講師登入：驗證 Google ID token、簽發／讀取登入 cookie
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (s) => JSON.parse(dec.decode(b64urlToBytes(s)));

// ---- Google ID token ----
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
let jwksCache = { at: 0, keys: null };

// 本機開發專用功能（DEV_LOGIN 測試登入、GOOGLE_JWKS 測試公鑰）的共同門檻：
// ENVIRONMENT=development，而且這次請求的 URL 主機名正好是迴環位址。兩者缺一就一律關閉（fail closed）。
export const LOOPBACK_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);
export function isLoopbackHostname(hostname) {
  return typeof hostname === "string" && LOOPBACK_HOSTNAMES.includes(hostname);
}
export function devOnlyAllowed(env, hostname) {
  return env.ENVIRONMENT === "development" && isLoopbackHostname(hostname);
}

async function googleKeys(env, force, allowTestKeys) {
  // 只在「開發模式＋迴環主機」允許以測試公鑰取代 Google 公鑰（本機測試用）；其他情況一律向 Google 取正式公鑰
  if (allowTestKeys === true && env.GOOGLE_JWKS) return JSON.parse(env.GOOGLE_JWKS).keys;
  if (!force && jwksCache.keys && Date.now() - jwksCache.at < 3600 * 1000) return jwksCache.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error(`無法取得 Google 公鑰（${r.status}）`);
  const j = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

// requestHostname：這次請求 URL 的主機名（new URL(request.url).hostname），用來判斷是否允許測試公鑰
export async function verifyGoogleIdToken(token, env, requestHostname) {
  const allowTestKeys = devOnlyAllowed(env, requestHostname);
  if (!env.GOOGLE_CLIENT_ID) throw new Error("伺服器尚未設定 Google 登入");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("登入憑證格式錯誤");
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { throw new Error("登入憑證格式錯誤"); }
  if (header.alg !== "RS256") throw new Error("登入憑證演算法不符");
  let keys = await googleKeys(env, false, allowTestKeys);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(env, true, allowTestKeys); jwk = keys.find((k) => k.kid === header.kid); } // Google 輪替金鑰
  if (!jwk) throw new Error("找不到對應的 Google 公鑰");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("登入憑證簽章無效");
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("登入憑證發行者不符");
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("登入憑證不是發給本服務的");
  if (!(Number(payload.exp) > now)) throw new Error("登入憑證已過期，請重新登入");
  if (payload.iat && Number(payload.iat) > now + 300) throw new Error("登入憑證時間異常");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("這個 Google 帳號的信箱尚未驗證");
  if (typeof payload.email !== "string") throw new Error("登入憑證缺少信箱");
  return { email: payload.email.toLowerCase(), name: String(payload.name || payload.email).slice(0, 40) };
}

// ---- 登入 cookie（HMAC 簽章，金鑰由 Auth DO 自動產生）----
export const SESSION_COOKIE = "aee_s";
export const SESSION_HOURS = 12;

async function hmacKey(secretB64) {
  return crypto.subtle.importKey("raw", b64urlToBytes(secretB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signSession(data, secretB64) {
  const body = bytesToB64url(enc.encode(JSON.stringify(data)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secretB64), enc.encode(body));
  return `${body}.${bytesToB64url(sig)}`;
}
export async function readSession(value, secretB64) {
  if (!value || !value.includes(".")) return null;
  const [body, sig] = value.split(".");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(secretB64), b64urlToBytes(sig), enc.encode(body)); } catch { return null; }
  if (!ok) return null;
  let data;
  try { data = JSON.parse(dec.decode(b64urlToBytes(body))); } catch { return null; }
  if (!data || typeof data.email !== "string" || !(data.exp > Date.now())) return null;
  return data;
}
export function getCookie(request, name) {
  const h = request.headers.get("Cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
export function sessionCookie(value, secure, maxAgeSec) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;
