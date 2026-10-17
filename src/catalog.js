// 簡報庫目錄（S3c-1）：獨立的 Catalog Durable Object（全站一個實例，名稱 "catalog"）。
// - 與 Auth DO 分開：簡報主機（S3d-B）只綁這個 DO，並只呼叫唯讀方法 getReadyDeck／resolveAsset。
// - 狀態機：pending → ready → disabled；pending → aborted；ready／disabled → revoked。aborted／revoked 是墓碑，紀錄不刪除，
//   同一個 (id, version) 不能再上傳（主鍵衝突 → 409）。
// - 每個狀態轉移都在方法的第一個 await 之前、只用同步 SQL 完成；R2 操作一律放在轉移之後（alarm 或 Worker）。
// - 逾期採惰性判斷：任何方法進場先把 expires_at ≤ now 的 pending 同步轉為 aborted，並排入清理。
// - 清理佇列 cleanup_queue：DO 只有一個 alarm，所以 alarm 一律設成 min(due_at)；每次 alarm 最多處理 3 個前綴，做不完就重新排程。
import { DurableObject } from "cloudflare:workers";
import { validateBeginBody, checkQuota, contentTypeFor, UPLOAD_LIMITS, UPLOAD_ID_RE } from "./deck-upload.js";

const PREFIXES_PER_ALARM = 3;
const RETRY_MS = 60 * 1000;
const LIST_LIMIT = 200;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const deckPrefix = (id, version, uploadId) => `decks/${id}/${version}/${uploadId}/`;
const uploadIdFromPrefix = (prefix) => {
  const parts = String(prefix).split("/");
  return parts.length === 5 && parts[0] === "decks" && parts[4] === "" && UPLOAD_ID_RE.test(parts[3]) ? parts[3] : null;
};

/** 刪除 R2 前綴下的所有物件：list 依 truncated 迴圈，每批 delete 最多 1000 鍵。 */
export async function deleteR2Prefix(bucket, prefix) {
  let cursor;
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); deleted += keys.length; }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return deleted;
}

export class Catalog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS decks (
      id TEXT NOT NULL, version TEXT NOT NULL, upload_id TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL,
      deck_json TEXT NOT NULL, files_json TEXT NOT NULL, bytes INTEGER NOT NULL, uploaded_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (id, version))`);
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decks_upload_id ON decks (upload_id)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS deck_upload_files (
      upload_id TEXT NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      received_at INTEGER, PRIMARY KEY (upload_id, idx))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cleanup_queue (prefix TEXT NOT NULL, due_at INTEGER NOT NULL, reason TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS cleanup_due ON cleanup_queue (due_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dev_kv (k TEXT PRIMARY KEY, v TEXT)`);
  }

  // ---- 開發用時鐘接縫（只在 ENVIRONMENT=development 且 DEV_CLOCK=1 時生效；Worker 另外要求迴環主機名＋管理者）----
  devClockEnabled() {
    return this.env.ENVIRONMENT === "development" && this.env.DEV_CLOCK === "1";
  }
  devValue(k) {
    if (!this.devClockEnabled()) return null;
    const row = this.sql.exec(`SELECT v FROM dev_kv WHERE k = ?`, k).toArray()[0];
    return row ? Number(row.v) : null;
  }
  now() {
    return Date.now() + (this.devValue("clockOffsetMs") || 0);
  }
  limits() {
    // 測試用配額覆寫只能「調低」總容量上限，不能放寬
    const q = this.devValue("quotaBytes");
    return q && q > 0 && q < UPLOAD_LIMITS.libraryBytesMax ? { ...UPLOAD_LIMITS, libraryBytesMax: q } : UPLOAD_LIMITS;
  }

  // ---- 內部：同步 SQL 的狀態轉移與清理排程 ----
  enqueue(prefix, dueAt, reason) {
    this.sql.exec(`INSERT INTO cleanup_queue (prefix, due_at, reason) VALUES (?, ?, ?)`, prefix, dueAt, reason);
  }
  // 進入墓碑狀態時排兩次清理：立即一次，10 分鐘後再一次（清掉晚到的物件）
  enqueueTombstoneCleanup(row, now, reason) {
    const prefix = deckPrefix(row.id, row.version, row.upload_id);
    this.enqueue(prefix, now, reason);
    this.enqueue(prefix, now + UPLOAD_LIMITS.secondCleanupMs, `${reason}-2`);
  }
  // 惰性逾期：所有 expires_at ≤ now 的 pending 同步轉為 aborted 並排清理。回傳是否有轉移（需要重排 alarm）。
  expireDue(now) {
    const rows = this.sql.exec(`SELECT id, version, upload_id FROM decks WHERE state = 'pending' AND expires_at <= ?`, now).toArray();
    for (const r of rows) {
      this.sql.exec(`UPDATE decks SET state = 'aborted' WHERE upload_id = ? AND state = 'pending'`, r.upload_id);
      this.enqueueTombstoneCleanup(r, now, "expired");
    }
    return rows.length > 0;
  }
  row(uploadId) {
    if (typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId)) return null;
    return this.sql.exec(`SELECT id, version, upload_id, state, uploaded_by, expires_at, files_json FROM decks WHERE upload_id = ?`, uploadId).toArray()[0] || null;
  }
  // 依 cleanup_queue 的最小 due_at 設定唯一的 alarm（時鐘接縫有偏移時換算回真實時間）
  async scheduleAlarm() {
    const next = this.sql.exec(`SELECT MIN(due_at) AS d FROM cleanup_queue`).one().d;
    if (next === null || next === undefined) { await this.ctx.storage.deleteAlarm(); return; }
    const offset = this.now() - Date.now();
    await this.ctx.storage.setAlarm(Math.max(Date.now(), Number(next) - offset));
  }

  // ---- [1] 開始上傳 ----
  // bodyText：Worker 以計數方式讀取、≤ 512 KiB 的本體。驗證、配額與 INSERT 全部同步完成，之後才 await（排 alarm）。
  async begin(bodyText, uploader) {
    const now = this.now();
    const v = validateBeginBody(bodyText);
    if (!v.ok) return v;
    const changed = this.expireDue(now);
    const { id, version, title } = v.deck;
    const existing = this.sql.exec(`SELECT state FROM decks WHERE id = ? AND version = ?`, id, version).toArray()[0];
    let result;
    if (existing) {
      result = { ok: false, status: 409, code: "deck_exists", error: "這個簡報 id 與版本已存在或曾被使用，請改用新版本號", path: "/deck/version" };
    } else {
      const usage = this.sql.exec(`SELECT
          COALESCE(SUM(CASE WHEN state = 'pending' AND uploaded_by = ? THEN 1 ELSE 0 END), 0) AS pendingByUploader,
          COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pendingGlobal,
          COALESCE(SUM(bytes), 0) AS bytesInUse,
          COUNT(*) AS liveDecks
        FROM decks WHERE state IN ('pending', 'ready', 'disabled')`, uploader).one();
      const q = checkQuota(usage, v.totalBytes, this.limits());
      if (!q.ok) result = q;
      else {
        const uploadId = hex(crypto.getRandomValues(new Uint8Array(16))); // 128 位元隨機值
        const expiresAt = now + UPLOAD_LIMITS.pendingTtlMs;
        try {
          this.sql.exec(`INSERT INTO decks (id, version, upload_id, state, title, deck_json, files_json, bytes, uploaded_by, created_at, expires_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
            id, version, uploadId, title, v.deckJson, JSON.stringify(v.files), v.totalBytes, uploader, now, expiresAt);
        } catch {
          return { ok: false, status: 409, code: "deck_exists", error: "這個簡報 id 與版本已存在或曾被使用，請改用新版本號", path: "/deck/version" };
        }
        v.files.forEach((f, i) => {
          this.sql.exec(`INSERT INTO deck_upload_files (upload_id, idx, path, size, sha256, received_at) VALUES (?, ?, ?, ?, ?, NULL)`, uploadId, i, f.path, f.size, f.sha256);
        });
        this.enqueue(deckPrefix(id, version, uploadId), expiresAt, "expire");
        result = { ok: true, status: 200, uploadId, id, version, expiresAt, files: v.files.length };
        await this.scheduleAlarm();
        return result;
      }
    }
    if (changed) await this.scheduleAlarm();
    return result;
  }

  // ---- [2] 上傳單檔：寫 R2 之前 ----
  async preparePut(uploadId, index, uploader) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.row(uploadId);
    let out;
    if (!r) out = { ok: false, status: 404, code: "upload_missing", error: "找不到這次上傳" };
    else if (r.uploaded_by !== uploader) out = { ok: false, status: 403, code: "not_uploader", error: "只有發起這次上傳的管理者可以上傳檔案" };
    else if (r.state !== "pending") out = { ok: false, status: 409, code: "not_pending", error: "這次上傳已不能再送檔案", state: r.state };
    else {
      const f = Number.isInteger(index) ? this.sql.exec(`SELECT path, size, sha256, received_at FROM deck_upload_files WHERE upload_id = ? AND idx = ?`, uploadId, index).toArray()[0] : null;
      if (!f) out = { ok: false, status: 400, code: "index_range", error: "檔案序號超出清單範圍" };
      else if (f.received_at !== null) out = { ok: true, status: 200, already: true, path: f.path };
      else out = { ok: true, status: 200, already: false, key: deckPrefix(r.id, r.version, uploadId) + f.path, path: f.path, size: f.size, sha256: f.sha256, contentType: contentTypeFor(f.path) };
    }
    if (changed) await this.scheduleAlarm();
    return out;
  }

  // ---- [2] 上傳單檔：R2 寫入成功之後，記錄已收到前再檢查一次狀態 ----
  // 回傳 deleteObject=true 時，Worker 必須刪除剛寫入的物件（這次上傳已不是 pending）。
  async markReceived(uploadId, index, uploader) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.row(uploadId);
    let out;
    if (!r) out = { ok: false, status: 404, code: "upload_missing", error: "找不到這次上傳", deleteObject: true };
    else if (r.uploaded_by !== uploader) out = { ok: false, status: 403, code: "not_uploader", error: "只有發起這次上傳的管理者可以上傳檔案", deleteObject: false };
    else {
      const f = this.sql.exec(`SELECT received_at FROM deck_upload_files WHERE upload_id = ? AND idx = ?`, uploadId, index).toArray()[0];
      if (!f) out = { ok: false, status: 400, code: "index_range", error: "檔案序號超出清單範圍", deleteObject: false };
      else if (f.received_at !== null) {
        // 同一檔已由另一個請求記錄：不刪除（物件屬於已收到的檔）；墓碑狀態的物件交給清理佇列
        out = r.state === "aborted" || r.state === "revoked"
          ? { ok: false, status: 409, code: "not_pending", error: "這次上傳已不能再送檔案", deleteObject: false }
          : { ok: true, status: 200, already: true };
      } else if (r.state !== "pending") {
        out = { ok: false, status: 409, code: "not_pending", error: "這次上傳已不能再送檔案", deleteObject: true };
      } else {
        this.sql.exec(`UPDATE deck_upload_files SET received_at = ? WHERE upload_id = ? AND idx = ?`, now, uploadId, index);
        out = { ok: true, status: 200, already: false };
      }
    }
    if (changed) await this.scheduleAlarm();
    return out;
  }

  // ---- [3] 確認 ----
  async commit(uploadId, uploader) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.row(uploadId);
    let out;
    if (!r) out = { ok: false, status: 404, code: "upload_missing", error: "找不到這次上傳" };
    else if (r.uploaded_by !== uploader) out = { ok: false, status: 403, code: "not_uploader", error: "只有發起這次上傳的管理者可以確認" };
    else if (r.state === "ready") out = { ok: true, status: 200, state: "ready", id: r.id, version: r.version };
    else if (r.state !== "pending") out = { ok: false, status: 409, code: "not_pending", error: "這次上傳已不能確認", state: r.state };
    else {
      const missing = this.sql.exec(`SELECT idx FROM deck_upload_files WHERE upload_id = ? AND received_at IS NULL ORDER BY idx`, uploadId).toArray().map((x) => x.idx);
      if (missing.length) out = { ok: false, status: 409, code: "files_missing", error: "還有檔案尚未上傳", missing };
      else {
        this.sql.exec(`UPDATE decks SET state = 'ready' WHERE upload_id = ? AND state = 'pending'`, uploadId);
        out = { ok: true, status: 200, state: "ready", id: r.id, version: r.version };
      }
    }
    if (changed) await this.scheduleAlarm();
    return out;
  }

  // ---- 中止：只限同一位上傳者，只接受 pending ----
  async abort(uploadId, uploader) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.row(uploadId);
    let out;
    let schedule = changed;
    if (!r) out = { ok: false, status: 404, code: "upload_missing", error: "找不到這次上傳" };
    else if (r.uploaded_by !== uploader) out = { ok: false, status: 403, code: "not_uploader", error: "只有發起這次上傳的管理者可以中止" };
    else if (r.state !== "pending") out = { ok: false, status: 409, code: "not_pending", error: r.state === "ready" || r.state === "disabled" ? "已完成的簡報請用撤銷下架" : "這次上傳已結束", state: r.state };
    else {
      this.sql.exec(`UPDATE decks SET state = 'aborted' WHERE upload_id = ? AND state = 'pending'`, uploadId);
      this.enqueueTombstoneCleanup(r, now, "aborted");
      schedule = true;
      out = { ok: true, status: 200, state: "aborted" };
    }
    if (schedule) await this.scheduleAlarm();
    return out;
  }

  // ---- 管理：停用（新場次不可選、既有場次照常）與撤銷（停止提供並刪除 R2 物件）----
  async disable(id, version) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.sql.exec(`SELECT state FROM decks WHERE id = ? AND version = ?`, String(id), String(version)).toArray()[0];
    let out;
    if (!r) out = { ok: false, status: 404, code: "deck_missing", error: "找不到這份簡報" };
    else if (r.state === "disabled") out = { ok: true, status: 200, state: "disabled" };
    else if (r.state !== "ready") out = { ok: false, status: 409, code: "bad_state", error: "只有可用的簡報可以停用", state: r.state };
    else {
      this.sql.exec(`UPDATE decks SET state = 'disabled' WHERE id = ? AND version = ? AND state = 'ready'`, String(id), String(version));
      out = { ok: true, status: 200, state: "disabled" };
    }
    if (changed) await this.scheduleAlarm();
    return out;
  }
  async revoke(id, version) {
    const now = this.now();
    const changed = this.expireDue(now);
    const r = this.sql.exec(`SELECT id, version, upload_id, state FROM decks WHERE id = ? AND version = ?`, String(id), String(version)).toArray()[0];
    let out;
    let schedule = changed;
    if (!r) out = { ok: false, status: 404, code: "deck_missing", error: "找不到這份簡報" };
    else if (r.state === "revoked") out = { ok: true, status: 200, state: "revoked" };
    else if (r.state !== "ready" && r.state !== "disabled") out = { ok: false, status: 409, code: "bad_state", error: "只有可用或已停用的簡報可以撤銷", state: r.state };
    else {
      this.sql.exec(`UPDATE decks SET state = 'revoked' WHERE upload_id = ? AND state IN ('ready', 'disabled')`, r.upload_id);
      this.enqueueTombstoneCleanup(r, now, "revoked");
      schedule = true;
      out = { ok: true, status: 200, state: "revoked" };
    }
    if (schedule) await this.scheduleAlarm();
    return out;
  }

  // ---- 列表：SQL 只選白名單欄位，最多 200 列；講師只看 ready，管理者另看 disabled ----
  async list(isAdmin) {
    const states = isAdmin ? ["ready", "disabled"] : ["ready"];
    const ph = states.map(() => "?").join(", ");
    return this.sql.exec(`SELECT id, version, title, state, created_at FROM decks WHERE state IN (${ph}) ORDER BY created_at DESC, id, version LIMIT ${LIST_LIMIT}`, ...states).toArray();
  }

  // ---- 給 S3d-B 的唯讀方法（不改任何狀態）----
  /** 狀態為 ready 時回傳 { deck_json, upload_id }；disabled、pending、墓碑或不存在一律回 null。建場用。 */
  async getReadyDeck(id, version) {
    if (typeof id !== "string" || typeof version !== "string") return null;
    const r = this.sql.exec(`SELECT deck_json, upload_id FROM decks WHERE id = ? AND version = ? AND state = 'ready'`, id, version).toArray()[0];
    return r ? { deck_json: r.deck_json, upload_id: r.upload_id } : null;
  }
  /** 狀態為 ready／disabled 且 path 在 files_json 內時回傳 R2 鍵，其餘回 null。 */
  async resolveAsset(uploadId, path) {
    if (typeof path !== "string") return null;
    const r = this.row(uploadId);
    if (!r || (r.state !== "ready" && r.state !== "disabled")) return null;
    let files;
    try { files = JSON.parse(r.files_json); } catch { return null; }
    if (!Array.isArray(files) || !files.some((f) => f && f.path === path)) return null;
    return deckPrefix(r.id, r.version, r.upload_id) + path;
  }

  // ---- 開發用（Worker 另以 devOnlyAllowed＋旗標＋管理者把關；這裡再確認 ENVIRONMENT 與旗標）----
  async devSetClock(offsetMs, quotaBytes) {
    if (!this.devClockEnabled()) return { ok: false };
    if (!Number.isSafeInteger(offsetMs)) return { ok: false };
    if (quotaBytes !== null && !(Number.isSafeInteger(quotaBytes) && quotaBytes > 0 && quotaBytes < UPLOAD_LIMITS.libraryBytesMax)) return { ok: false };
    this.sql.exec(`INSERT INTO dev_kv (k, v) VALUES ('clockOffsetMs', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(offsetMs));
    if (quotaBytes) this.sql.exec(`INSERT INTO dev_kv (k, v) VALUES ('quotaBytes', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(quotaBytes));
    else this.sql.exec(`DELETE FROM dev_kv WHERE k = 'quotaBytes'`);
    // 不在這裡做惰性逾期：重排 alarm 後由 alarm 處理到期的 "expire" 項目（驗收 alarm 路徑）
    await this.scheduleAlarm();
    return { ok: true, now: this.now(), offsetMs, quotaBytes: quotaBytes || null };
  }
  async devCleanupQueue(prefix) {
    if (this.env.ENVIRONMENT !== "development" || this.env.DEV_INSPECT !== "1") return null;
    return this.sql.exec(`SELECT prefix, due_at, reason FROM cleanup_queue WHERE prefix = ? ORDER BY due_at`, String(prefix)).toArray();
  }
  async devNow() {
    return this.now();
  }

  // ---- alarm：處理到期的清理項目（每次最多 3 個前綴）----
  async alarm() {
    const now = this.now();
    this.expireDue(now);
    const due = this.sql.exec(`SELECT rowid AS rid, prefix, reason FROM cleanup_queue WHERE due_at <= ? ORDER BY due_at, rowid`, now).toArray();
    const done = new Set();
    let processed = 0;
    for (const item of due) {
      if (done.has(item.prefix)) { this.sql.exec(`DELETE FROM cleanup_queue WHERE rowid = ?`, item.rid); continue; }
      if (processed >= PREFIXES_PER_ALARM) break;
      const uploadId = uploadIdFromPrefix(item.prefix);
      const r = uploadId ? this.row(uploadId) : null;
      // 只刪除墓碑狀態（aborted／revoked）的前綴；"expire" 項目若上傳已完成（ready／disabled）就直接丟棄
      if (!r || (r.state !== "aborted" && r.state !== "revoked")) { this.sql.exec(`DELETE FROM cleanup_queue WHERE rowid = ?`, item.rid); continue; }
      processed++;
      try {
        await deleteR2Prefix(this.env.DECKS, item.prefix);
        this.sql.exec(`DELETE FROM cleanup_queue WHERE rowid = ?`, item.rid);
        done.add(item.prefix);
      } catch {
        this.sql.exec(`UPDATE cleanup_queue SET due_at = ? WHERE rowid = ?`, this.now() + RETRY_MS, item.rid);
      }
    }
    await this.scheduleAlarm();
  }
}
