// 本機測試用：產生「假 Google」RSA 金鑰，把公鑰寫進 .dev.vars（只在 ENVIRONMENT=development 生效），
// 私鑰存到 .wrangler/test-google-key.json（已被 git 忽略），供 smoke-auth.mjs 簽發測試用 ID token。
// 要在本機改用真正的 Google 登入時：把 .dev.vars 的 GOOGLE_CLIENT_ID 換成你自己的真實值、刪掉 GOOGLE_JWKS 這行。
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const varsPath = join(root, ".dev.vars");
const keyPath = join(root, ".wrangler", "test-google-key.json");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "local-test-" + randomUUID().slice(0, 8);
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
mkdirSync(dirname(keyPath), { recursive: true });
writeFileSync(keyPath, JSON.stringify({ kid, privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) }));

const keep = existsSync(varsPath)
  ? readFileSync(varsPath, "utf8").split(/\r?\n/).filter((l) => l && !/^(ENVIRONMENT|GOOGLE_CLIENT_ID|GOOGLE_JWKS|ADMIN_EMAILS|DEV_LOGIN)=/.test(l))
  : [];
// 本機管理者：測試帳號 admin@example.test
const lines = [
  ...keep,
  "ENVIRONMENT=development",
  "GOOGLE_CLIENT_ID=local-test-client.apps.googleusercontent.com",
  "ADMIN_EMAILS=admin@example.test",
  "DEV_LOGIN=1",
  `GOOGLE_JWKS='${JSON.stringify({ keys: [jwk] })}'`,
];
writeFileSync(varsPath, lines.join("\n") + "\n");
console.log("已寫入本機測試設定（管理者：admin@example.test；開啟本機測試登入）。重新啟動 wrangler dev 後生效。");
