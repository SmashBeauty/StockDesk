// A small document store in Postgres. Paths match the original Stock Desk page's
// database ("pos/<id>", "stores/<key>/chunks/c0", "config/settings"...), so the page
// works unchanged and existing data can be imported as-is.
import pg from "pg";
import { config } from "./config.js";

const ssl = /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false };
export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 5 });

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      path       text PRIMARY KEY,
      parent     text NOT NULL,
      id         text NOT NULL,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
    CREATE TABLE IF NOT EXISTS meta (k text PRIMARY KEY, v jsonb NOT NULL);
    INSERT INTO meta(k, v) VALUES ('version', '0') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS shop_tokens (
      store              text PRIMARY KEY,
      shop               text NOT NULL,
      access_token       text NOT NULL,
      refresh_token      text,
      expires_at         timestamptz,
      refresh_expires_at timestamptz,
      scope              text,
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sync_runs (
      id         serial PRIMARY KEY,
      store      text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz,
      ok         boolean,
      message    text
    );
  `);
}

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
export function checkPath(path, kind) {
  const parts = String(path || "").split("/");
  if (!parts.every((p) => SEG.test(p) && p !== "." && p !== "..")) throw httpError(400, "Bad path");
  const isDoc = parts.length % 2 === 0;
  if (kind === "doc" && !isDoc) throw httpError(400, "Not a document path");
  if (kind === "collection" && isDoc) throw httpError(400, "Not a collection path");
  return parts;
}
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function bump(client) {
  const r = await client.query(`UPDATE meta SET v = to_jsonb((v::text)::bigint + 1) WHERE k = 'version' RETURNING v`);
  return Number(r.rows[0].v);
}

export async function version() {
  const r = await pool.query(`SELECT v FROM meta WHERE k = 'version'`);
  return Number(r.rows[0]?.v || 0);
}

export async function getDoc(path) {
  checkPath(path, "doc");
  const r = await pool.query(`SELECT data FROM docs WHERE path = $1`, [path]);
  return r.rows[0] ? r.rows[0].data : null;
}

export async function listCollection(path) {
  checkPath(path, "collection");
  const r = await pool.query(`SELECT id, data FROM docs WHERE parent = $1 ORDER BY id`, [path]);
  return r.rows.map((x) => ({ id: x.id, data: x.data }));
}

// Lightweight listing for big collections (stores): id + top-level data without chunks.
export async function setDoc(path, data) {
  const parts = checkPath(path, "doc");
  if (data == null || typeof data !== "object" || Array.isArray(data)) throw httpError(400, "Document must be an object");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO docs(path, parent, id, data, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [path, parts.slice(0, -1).join("/"), parts[parts.length - 1], JSON.stringify(data)]
    );
    const v = await bump(client);
    await client.query("COMMIT");
    return v;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteDoc(path) {
  checkPath(path, "doc");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM docs WHERE path = $1 OR path LIKE $2`, [path, path.replace(/[%_\\]/g, "\\$&") + "/%"]);
    const v = await bump(client);
    await client.query("COMMIT");
    return v;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Replace a whole store snapshot (meta + chunks) in one transaction, so the page never
// sees half a sync.
export async function replaceStore(key, meta, chunks) {
  const base = `stores/${key}`;
  checkPath(base, "doc");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM docs WHERE parent = $1`, [`${base}/chunks`]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO docs(path, parent, id, data) VALUES ($1, $2, $3, $4)`,
        [`${base}/chunks/c${i}`, `${base}/chunks`, `c${i}`, JSON.stringify({ rows: chunks[i] })]
      );
    }
    await client.query(
      `INSERT INTO docs(path, parent, id, data, updated_at) VALUES ($1, 'stores', $2, $3, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [base, key, JSON.stringify({ ...meta, chunks: chunks.length })]
    );
    await bump(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function startRun(store) {
  const r = await pool.query(`INSERT INTO sync_runs(store) VALUES ($1) RETURNING id`, [store]);
  return r.rows[0].id;
}
export async function endRun(id, ok, message) {
  await pool.query(`UPDATE sync_runs SET ended_at = now(), ok = $2, message = $3 WHERE id = $1`, [id, ok, String(message || "").slice(0, 2000)]);
}
export async function lastRuns() {
  const r = await pool.query(
    `SELECT DISTINCT ON (store) store, started_at, ended_at, ok, message FROM sync_runs ORDER BY store, started_at DESC`
  );
  return r.rows;
}

// Shopify OAuth tokens (kept out of the docs table so the page API can never read them).
export async function getShopToken(store) {
  const r = await pool.query(`SELECT * FROM shop_tokens WHERE store = $1`, [store]);
  return r.rows[0] || null;
}
export async function saveShopToken(store, shop, t) {
  const exp = t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000) : null;
  const rexp = t.refresh_token_expires_in ? new Date(Date.now() + Number(t.refresh_token_expires_in) * 1000) : null;
  await pool.query(
    `INSERT INTO shop_tokens(store, shop, access_token, refresh_token, expires_at, refresh_expires_at, scope, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (store) DO UPDATE SET shop=EXCLUDED.shop, access_token=EXCLUDED.access_token,
       refresh_token=COALESCE(EXCLUDED.refresh_token, shop_tokens.refresh_token), expires_at=EXCLUDED.expires_at,
       refresh_expires_at=COALESCE(EXCLUDED.refresh_expires_at, shop_tokens.refresh_expires_at),
       scope=COALESCE(EXCLUDED.scope, shop_tokens.scope), updated_at=now()`,
    [store, shop, t.access_token, t.refresh_token || null, exp, rexp, t.scope || null]
  );
}
