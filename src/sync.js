// Server-side store sync. Produces exactly the row format the Stock Desk page reads
// (see decode() in public/index.html), so the page needs no changes to its maths.
import { clientFor } from "./shopify.js";
import { replaceStore, startRun, endRun, getDoc, setDoc } from "./db.js";
import { config } from "./config.js";
import { sendAlert } from "./alerts.js";

const DAY = 864e5;
const STATUS_CODE = { ACTIVE: "A", DRAFT: "D", ARCHIVED: "X" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);
const parseDay = (s) => Date.parse(String(s).slice(0, 10) + "T00:00:00Z");
function todayUTC() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

const running = new Map(); // storeId -> {startedAt, step, frac}
export function syncStatus() {
  return Object.fromEntries([...running.entries()]);
}

export async function syncStore(storeId, log = console.log) {
  if (running.has(storeId)) return { skipped: true };
  const sh = clientFor(storeId);
  if (!sh) throw new Error(`Store "${storeId}" is not set up (missing ${storeId.toUpperCase()}_SHOP / _CLIENT_ID / _CLIENT_SECRET).`);
  const st = { startedAt: new Date().toISOString(), step: "starting", frac: 0 };
  running.set(storeId, st);
  const runId = await startRun(storeId);
  try {
    const res = await doSync(sh, (frac, step) => {
      st.frac = frac;
      st.step = step;
    }, log);
    await endRun(runId, true, `${res.rows} variants, ${res.sold} sold, ${res.negatives} negative`);
    return res;
  } catch (e) {
    await endRun(runId, false, e.message);
    throw e;
  } finally {
    running.delete(storeId);
  }
}

async function doSync(sh, progress, log) {
  const TODAY = todayUTC();
  const CUR = new Date(TODAY);
  const nowMonth = CUR.getUTCFullYear() * 12 + CUR.getUTCMonth();
  const info = await sh.shopInfo();
  const name = info.name;
  const key = info.domain.replace(/[^a-z0-9._-]+/g, "-").slice(0, 120) || sh.store.id;
  progress(0.01, `${name}: counting variants`);
  const cnt = await sh.gql(`{ productVariantsCount { count } }`);
  const total = cnt.productVariantsCount?.count || 0;

  const variants = [];
  let after = null;
  for (;;) {
    const q = `query($after: String) { productVariants(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id sku barcodes(first: 1) { nodes { value } } title price compareAtPrice inventoryQuantity createdAt selectedOptions { name value } inventoryItem { id unitCost { amount } inventoryLevels(first: 1) { nodes { location { id } quantities(names: ["committed","on_hand","incoming"]) { name quantity } } } } product { title handle vendor productType status } } } }`;
    const pv = (await sh.gql(q, { after })).productVariants;
    variants.push(...pv.nodes);
    progress(0.02 + 0.55 * (variants.length / Math.max(total, variants.length)), `${name}: variants ${variants.length}/${total}`);
    if (!pv.pageInfo.hasNextPage) break;
    after = pv.pageInfo.endCursor;
  }
  log(`${name}: ${variants.length} variants`);

  // 25 thirty-day windows ≈ 24 months of daily sales per variant.
  const windows = [];
  for (let w = 0; w < 25; w++) {
    const until = TODAY - w * 30 * DAY;
    windows.push([until - 29 * DAY, until]);
  }
  const agg = new Map();
  async function runWindow(since, until) {
    const q = `FROM sales SHOW net_items_sold, net_sales GROUP BY product_variant_id, day SINCE ${ymd(new Date(since))} UNTIL ${ymd(new Date(until))} HAVING net_items_sold > 0 LIMIT 10000`;
    const r = await sh.shopifyql(q);
    const cols = r.columns.map((c) => c.name);
    const rows = r.rows;
    if (rows.length && (rows.length >= 10000 || rows.length % 1000 === 0) && until - since >= DAY) {
      const mid = since + Math.floor((until - since) / DAY / 2) * DAY;
      await runWindow(since, mid);
      await runWindow(mid + DAY, until);
      return;
    }
    const iV = cols.indexOf("product_variant_id"), iD = cols.indexOf("day"), iU = cols.indexOf("net_items_sold"), iS = cols.indexOf("net_sales");
    for (const row of rows) {
      const vid = String(row[iV] || "").split("/").pop();
      if (!vid) continue;
      const units = Number(row[iU]) || 0;
      if (units <= 0) continue;
      const day = String(row[iD]).slice(0, 10), dt = parseDay(day), ago = Math.round((TODAY - dt) / DAY);
      let a = agg.get(vid);
      if (!a) {
        a = { last: "", u30: 0, u90: 0, u365: 0, rev: 0, s: 0, ss: 0, m: new Array(24).fill(0), pts: [] };
        agg.set(vid, a);
      }
      if (day > a.last) a.last = day;
      if (ago < 30) a.u30 += units;
      if (ago < 90) {
        a.u90 += units;
        a.s += units;
        a.ss += units * units;
      }
      if (ago < 365) {
        a.u365 += units;
        a.rev += Number(row[iS]) || 0;
        a.pts.push([ago, units]);
      }
      const dd = new Date(dt), mo = nowMonth - (dd.getUTCFullYear() * 12 + dd.getUTCMonth());
      if (mo >= 0 && mo < 24) a.m[23 - mo] += units;
    }
  }
  let done = 0;
  const queue = windows.slice();
  async function worker() {
    while (queue.length) {
      const [a, b] = queue.shift();
      await runWindow(a, b);
      done++;
      progress(0.57 + 0.33 * (done / windows.length), `${name}: sales month ${done}/${windows.length}`);
    }
  }
  await Promise.all([worker(), worker()]);

  const rows = [];
  const negatives = [];
  for (const v of variants) {
    const vid = String(v.id).split("/").pop(), p = v.product || {}, a = agg.get(vid);
    const colorOpt = (v.selectedOptions || []).find((o) => /colou?r|shade|tone/i.test(o.name));
    const cost = v.inventoryItem && v.inventoryItem.unitCost ? Number(v.inventoryItem.unitCost.amount) : null;
    let sd = 0, u30e = 0, u90e = 0;
    if (a) {
      const mean = a.s / 90;
      sd = Math.sqrt(Math.max(0, a.ss / 90 - mean * mean));
      const lastAgo = a.last ? Math.round((TODAY - parseDay(a.last)) / DAY) : 0;
      for (const [ago, u] of a.pts) {
        const rel = ago - lastAgo;
        if (rel >= 0 && rel < 90) {
          u90e += u;
          if (rel < 30) u30e += u;
        }
      }
    }
    const lv = v.inventoryItem?.inventoryLevels?.nodes?.[0], qv = {};
    if (lv) for (const x of lv.quantities || []) qv[x.name] = x.quantity;
    const iid = v.inventoryItem?.id ? String(v.inventoryItem.id).split("/").pop() : "";
    const lid = lv?.location ? String(lv.location.id).split("/").pop() : "";
    const barcode = v.barcodes?.nodes?.[0]?.value || "";
    const onhand = Number(v.inventoryQuantity) || 0;
    rows.push([
      vid, v.sku || "", p.title || "", v.title === "Default Title" ? "" : v.title || "", colorOpt ? colorOpt.value : "", p.handle || "", p.vendor || "", p.productType || "",
      STATUS_CODE[p.status] || "U", Number(v.price) || 0, v.compareAtPrice ? Number(v.compareAtPrice) : null, cost != null && isFinite(cost) ? cost : null,
      onhand, (v.createdAt || "").slice(0, 10),
      a ? a.u30 : 0, a ? a.u90 : 0, a ? a.u365 : 0, a ? Math.round(a.rev * 100) / 100 : 0, a ? a.last : "", Math.round(sd * 1000) / 1000,
      a ? a.m : null, barcode, u30e, u90e, iid, lid, qv.committed != null ? qv.committed : null, qv.on_hand != null ? qv.on_hand : null, qv.incoming || 0,
    ]);
    const inStock = qv.on_hand != null ? qv.on_hand : onhand;
    if (p.status !== "ARCHIVED" && (inStock < 0 || onhand < 0)) {
      negatives.push({ vid, sku: v.sku || "", barcode, title: p.title || "", variant: v.title === "Default Title" ? "" : v.title || "", onHand: inStock, available: onhand, last: a ? a.last : "" });
    }
  }

  progress(0.92, `${name}: saving`);
  const chunks = [];
  let cur = [], size = 0;
  for (const r of rows) {
    const l = JSON.stringify(r).length + 1;
    if (size + l > 190000 && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += l;
  }
  if (cur.length) chunks.push(cur);
  const meta = { key, name, domain: info.domain, v: 2, syncedAt: new Date().toISOString(), rowCount: rows.length, soldVariants: agg.size, source: "server" };
  await replaceStore(key, meta, chunks);
  await recordNegatives(key, name, negatives, log);
  progress(1, `${name}: done`);
  log(`${name}: saved ${rows.length} variants in ${chunks.length} parts; ${negatives.length} negative`);
  return { store: key, rows: rows.length, sold: agg.size, negatives: negatives.length };
}

// Keep the current negative list per store and alert only on items that are newly
// negative (or got more negative) since the last alert.
async function recordNegatives(key, name, list, log) {
  const path = `alerts/negative-${key}`;
  const prev = (await getDoc(path)) || { items: [] };
  const before = new Map((prev.items || []).map((x) => [x.vid, x]));
  const fresh = list.filter((x) => {
    const p = before.get(x.vid);
    return !p || x.onHand < p.onHand;
  });
  list.sort((a, b) => a.onHand - b.onHand);
  await setDoc(path, { store: key, name, at: new Date().toISOString(), items: list, newCount: fresh.length });
  if (fresh.length) {
    try {
      await sendAlert(name, fresh, list.length);
    } catch (e) {
      log(`${name}: alert email failed: ${e.message}`);
    }
  }
}

export async function syncAll(log = console.log) {
  const out = [];
  for (const s of config.stores) {
    try {
      out.push(await syncStore(s.id, log));
    } catch (e) {
      log(`${s.id}: sync failed: ${e.message}`);
      out.push({ store: s.id, error: e.message });
    }
    await sleep(500);
  }
  return out;
}
