import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config, assertServerConfig } from "./config.js";
import { migrate, getDoc, setDoc, deleteDoc, listCollection, version, lastRuns, httpError, getShopToken, saveShopToken } from "./db.js";
import { clientForDomain, clientFor, SCOPES } from "./shopify.js";
import { syncAll, syncStore, syncStatus } from "./sync.js";
import { alertConfigured } from "./alerts.js";

assertServerConfig();
await migrate();

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/* ---------- login (signed cookie) ---------- */
const COOKIE = "sd_session";
const MAX_AGE = 30 * 24 * 3600 * 1000;
const sign = (v) => crypto.createHmac("sha256", config.sessionSecret).update(v).digest("base64url");
function makeSession(name) {
  const v = Buffer.from(JSON.stringify({ n: name, e: Date.now() + MAX_AGE })).toString("base64url");
  return `${v}.${sign(v)}`;
}
function readSession(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [v, s] = m[1].split(".");
  if (!v || !s) return null;
  const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(v, "base64url").toString());
    return o.e > Date.now() && config.users.some((u) => u.name === o.n) ? o.n : null;
  } catch {
    return null;
  }
}
function apiKeyOk(req) {
  const h = req.headers.authorization || "";
  if (!config.apiKey || !h.startsWith("Bearer ")) return false;
  const a = Buffer.from(h.slice(7)), b = Buffer.from(config.apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tries = new Map();
function limited(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 15 * 60_000);
  tries.set(ip, t);
  return t.length >= 10;
}

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.get("/login", (req, res) => res.sendFile(path.join(publicDir, "login.html")));
app.post("/login", (req, res) => {
  const ip = req.ip;
  if (limited(ip)) return res.redirect("/login?e=wait");
  const { name = "", password = "" } = req.body || {};
  const u = config.users.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
  const ok = u && Buffer.from(password).length === Buffer.from(u.password).length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(u.password));
  if (!ok) {
    tries.get(ip).push(Date.now());
    return res.redirect("/login?e=1");
  }
  res.setHeader("Set-Cookie", `${COOKIE}=${makeSession(u.name)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE / 1000}`);
  res.redirect("/");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect("/login");
});

/* ---------- Shopify app install (authorization code grant) ---------- */
// Dev Dashboard app settings: App URL = <APP_URL>/connect, redirect URL = <APP_URL>/shopify/callback
const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
app.get("/shopify/install", (req, res) => {
  if (!readSession(req)) return res.redirect("/login");
  const s = config.stores.find((x) => x.id === req.query.store);
  if (!s) return res.status(404).send("Unknown store. Check SMASH_* / VENERATE_* settings in Render.");
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = `${s.id}.${nonce}.${sign(s.id + "." + nonce)}`;
  const url = `https://${s.shop}.myshopify.com/admin/oauth/authorize?` +
    new URLSearchParams({ client_id: s.clientId, scope: SCOPES, redirect_uri: `${baseUrl(req)}/shopify/callback`, state });
  res.setHeader("Set-Cookie", `sd_oauth=${nonce}; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.redirect(url);
});
app.get("/shopify/callback", async (req, res) => {
  try {
    const q = req.query;
    const [storeId, nonce, sig] = String(q.state || "").split(".");
    const s = config.stores.find((x) => x.id === storeId);
    const cookieNonce = ((req.headers.cookie || "").match(/(?:^|;\s*)sd_oauth=([^;]+)/) || [])[1];
    if (!s || !nonce || nonce !== cookieNonce || sig !== sign(storeId + "." + nonce)) return res.status(403).send("This sign-in link expired. Go back to Stock Desk and press Connect again.");
    if (String(q.shop).toLowerCase() !== `${s.shop}.myshopify.com`.toLowerCase()) return res.status(400).send(`Shopify returned ${q.shop}, but this app is set up for ${s.shop}.myshopify.com.`);
    const msg = Object.entries(q).filter(([k]) => k !== "hmac" && k !== "signature").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    const digest = crypto.createHmac("sha256", s.clientSecret).update(msg).digest("hex");
    if (digest.length !== String(q.hmac || "").length || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(q.hmac)))) return res.status(403).send("Shopify's signature didn't match.");
    const r = await fetch(`https://${s.shop}.myshopify.com/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, code: String(q.code), expiring: "1" }),
    });
    if (!r.ok) return res.status(502).send(`Shopify didn't issue a token (${r.status}).`);
    const t = await r.json();
    await saveShopToken(s.id, s.shop, t);
    res.setHeader("Set-Cookie", `sd_oauth=; Path=/shopify; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    res.redirect(`/connect?ok=${encodeURIComponent(s.id)}`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Connecting the store failed: " + e.message);
  }
});

app.use((req, res, next) => {
  const user = readSession(req) || (apiKeyOk(req) ? "api" : null);
  if (user) {
    req.user = user;
    return next();
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please sign in again." });
  res.redirect("/login");
});

/* ---------- store connections ---------- */
app.get("/connect", wrap(async (req, res) => {
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Coming back from Shopify's install screen (App URL): finish connecting right away.
  if (req.query.shop && !req.query.ok) {
    const s = config.stores.find((x) => `${x.shop}.myshopify.com` === String(req.query.shop).toLowerCase());
    if (s && !(await getShopToken(s.id).catch(() => null))) return res.redirect(`/shopify/install?store=${s.id}`);
  }
  const rows = [];
  for (const s of config.stores) {
    const t = await getShopToken(s.id).catch(() => null);
    let status = t ? `Connected (installed ${new Date(t.updated_at).toLocaleDateString("en-US")})` : "Not connected yet";
    let name = "";
    try { name = (await clientFor(s.id).shopInfo()).name; status += " · Shopify answered: " + name; } catch (e) { if (t) status += " · Error: " + e.message; }
    rows.push(`<tr><td><b>${esc(s.id)}</b><br><span>${esc(s.shop)}.myshopify.com</span></td><td>${esc(status)}</td><td><a class="btn" href="/shopify/install?store=${esc(s.id)}">${t ? "Reconnect" : "Connect"}</a></td></tr>`);
  }
  const ok = req.query.ok ? `<p class="ok">${esc(req.query.ok)} is connected. The next sync will use it.</p>` : "";
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stock Desk · Stores</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#F4F5F8;color:#1B1D26;margin:0;padding:24px 16px}main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #DCE0E8;border-radius:12px;padding:20px}
table{width:100%;border-collapse:collapse}td{padding:10px 8px;border-bottom:1px solid #DCE0E8;vertical-align:top}td span{color:#5C6273;font-size:.85rem}.btn{display:inline-block;background:#86275F;color:#fff;padding:7px 14px;border-radius:8px;text-decoration:none}.ok{background:#E3F3EA;color:#1D7A4C;padding:8px 12px;border-radius:8px}</style>
<main><p><a href="/">← Stock Desk</a></p><h1>Shopify stores</h1>${ok}
<p>Each store connects through its own Shopify app (Smash Stock Desk, Venerate Stock Desk). Press Connect and approve in Shopify.</p>
<table>${rows.join("") || "<tr><td>No stores set up. Add SMASH_* / VENERATE_* settings in Render.</td></tr>"}</table></main>`);
}));

/* ---------- page ---------- */
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "index.html"));
});
app.use(express.static(publicDir, { index: false, maxAge: "5m" }));

/* ---------- document store (what the page's db calls use) ---------- */
function wrap(fn) {
  return (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      if (!e.status) console.error(e);
      res.status(e.status || 500).json({ error: e.status ? e.message : "Server error: " + e.message });
    });
}

app.get("/api/version", wrap(async (req, res) => res.json({ version: await version() })));
app.get("/api/doc", wrap(async (req, res) => {
  const data = await getDoc(String(req.query.path || ""));
  res.json({ exists: data != null, data });
}));
app.get("/api/collection", wrap(async (req, res) => res.json({ docs: await listCollection(String(req.query.path || "")) })));
app.put("/api/doc", wrap(async (req, res) => {
  const p = String(req.query.path || "");
  if (p.startsWith("stores/")) throw httpError(403, "Store data is written by the sync only.");
  res.json({ version: await setDoc(p, req.body) });
}));
app.delete("/api/doc", wrap(async (req, res) => {
  const p = String(req.query.path || "");
  if (p.startsWith("stores/")) throw httpError(403, "Store data is written by the sync only.");
  res.json({ version: await deleteDoc(p) });
}));

/* ---------- session info ---------- */
app.get("/api/me", wrap(async (req, res) => {
  res.json({
    user: req.user,
    canWrite: true,
    shopifyWrites: config.allowShopifyWrites,
    stores: config.stores.map((s) => s.id),
    alertsEmail: alertConfigured(),
  });
}));

/* ---------- Shopify ---------- */
const isMutation = (q) => /^\s*mutation\b/.test(String(q || "").replace(/#[^\n]*\n/g, "").trim());
app.post("/api/shopify/info", wrap(async (req, res) => {
  const c = await clientForDomain(req.body.store);
  if (!c) throw httpError(404, `Stock Desk isn't connected to ${req.body.store}. Check its Shopify app settings in Render.`);
  res.json(await c.shopInfo());
}));
app.post("/api/shopify/graphql", wrap(async (req, res) => {
  const { store, query, variables } = req.body || {};
  if (isMutation(query) && !config.allowShopifyWrites)
    throw httpError(403, "Shopify stock changes are switched off in this version of Stock Desk (testing). Nothing was changed. Ask the owner to turn on ALLOW_SHOPIFY_WRITES.");
  if (isMutation(query) && !/^\s*mutation\s+StockDeskAdjust\b/.test(query))
    throw httpError(403, "Only stock adjustments are allowed from Stock Desk.");
  const c = await clientForDomain(store);
  if (!c) throw httpError(404, `Stock Desk isn't connected to ${store}.`);
  res.json(await c.raw(query, variables));
}));

/* ---------- sync ---------- */
app.post("/api/sync", wrap(async (req, res) => {
  const which = req.body?.store;
  if (which) syncStore(which).catch((e) => console.error(e));
  else syncAll().catch((e) => console.error(e));
  res.json({ started: true });
}));
app.get("/api/sync", wrap(async (req, res) => res.json({ running: syncStatus(), last: await lastRuns() })));

/* ---------- alerts ---------- */
app.get("/api/alerts/negative", wrap(async (req, res) => {
  const docs = (await listCollection("alerts")).filter((d) => d.id.startsWith("negative-"));
  res.json({ stores: docs.map((d) => d.data) });
}));

app.listen(config.port, () => console.log(`Stock Desk listening on ${config.port}; stores: ${config.stores.map((s) => s.id).join(", ") || "none"}; Shopify writes ${config.allowShopifyWrites ? "ON" : "OFF"}`));
