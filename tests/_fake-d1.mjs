/* Minimal D1-style shim over in-memory SQLite, shared by the tests. */
import { DatabaseSync } from "node:sqlite";

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    let lastRowId = null;
    try {
      lastRowId = this.db.prepare("SELECT last_insert_rowid() AS id").get().id;
    } catch (e) { /* not an insert */ }
    return { success: true, meta: { last_row_id: lastRowId, changes: info ? Number(info.changes) : 0 } };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row === undefined ? null : row;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
export class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  prepare(sql) { return new Statement(this.db, sql); }
  /* D1's batch(): every statement runs in one transaction, with no
     other request able to interleave — node:sqlite is synchronous, so
     running them back to back inside BEGIN/COMMIT matches that. */
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((st) => {
        if (/^\s*(SELECT|PRAGMA)/i.test(st.sql)) return { results: this.db.prepare(st.sql).all(...st.args) };
        const info = this.db.prepare(st.sql).run(...st.args);
        return { results: [], meta: { changes: Number(info.changes) } };
      });
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
/* Setup is locked behind the SETUP_SECRET env secret since v7; the
   suites use this dummy value. */
export const TEST_SETUP_SECRET = "test-setup-secret";
export function makeCtx(env, body, method, url, headers) {
  return {
    env,
    request: new Request(url || "http://local/api/budget", {
      method,
      headers: { "Content-Type": "application/json", ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  };
}

/* ---- auth bootstrap for handler suites -------------------------------
 * Since v6 every data endpoint requires a session once an access code
 * exists (and answers 403 setupRequired before one does). Suites opt in
 * ONCE per fresh fake DB: setupTestAuth performs the real setup action
 * and returns the raw token; authedCtx wraps makeCtx to attach it, and
 * authHeaders is the same for hand-built contexts. */
export function authHeaders(token) {
  return token ? { Authorization: "Bearer " + token } : {};
}
export function authedCtx(env, token) {
  return (body, method, url, headers) =>
    makeCtx(env, body, method, url, { ...authHeaders(token), ...(headers || {}) });
}
export async function setupTestAuth(env, code = "test-code-123") {
  const { onRequestPost } = await import("../functions/api/auth.js");
  if (!env.SETUP_SECRET) env.SETUP_SECRET = TEST_SETUP_SECRET;
  const res = await onRequestPost(makeCtx(env, { action: "setup", setupSecret: env.SETUP_SECRET, code, label: "Test device" }, "POST", "http://local/api/auth"));
  if (res.status !== 200) throw new Error("test auth setup failed: " + res.status + " " + (await res.text()));
  const body = await res.json();
  return body.token;
}
