// Dependency-free stand-in for src/server.js (in-memory documents, fake Shopify),
// used to check the page and shim in a browser: node test/mock-server.js [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const docs = new Map();
let ver = 1;
const calls = [];
export { calls };

function seed() {
  const stores = [["smashbeautysupply.com", "Smash Beauty Supply"], ["veneratebeautysupply.com", "Venerate Beauty Supply"]];
  for (const [key, name] of stores) {
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const m = new Array(24).fill(0).map((_, k) => (i % 7) + (k % 3));
      const onhand = i === 3 ? -2 : (i * 3) % 17;
      rows.push([String(1000 + i), `SKU${i}`, `Test product ${i}`, i % 2 ? "Black" : "", i % 2 ? "Black" : "", `test-${i}`, i % 3 ? "KISS" : "Outre", "Hair", "A", 9.99, null, 4.5, onhand, "2025-01-01",
        6, 18, 70, 600, "2026-11-10", 0.4, m, `0000${i}`, 6, 18, String(5000 + i), "61833937093", 0, onhand, 0]);
    }
    docs.set(`stores/${key}`, { key, name, domain: key, v: 2, syncedAt: new Date().toISOString(), rowCount: rows.length, soldVariants: 60, chunks: 1 });
    docs.set(`stores/${key}/chunks/c0`, { rows });
  }
  docs.set("alerts/negative-smashbeautysupply.com", { name: "Smash Beauty Supply", items: [{ sku: "SKU3", title: "Test product 3", onHand: -2 }] });
}
seed();

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const parent = (p) => p.split("/").slice(0, -1).join("/");

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : undefined;
    const p = u.searchParams.get("path");
    if (u.pathname === "/" || u.pathname.endsWith(".js") || u.pathname.endsWith(".html")) {
      const f = path.join(pub, u.pathname === "/" ? "index.html" : u.pathname);
      if (!fs.existsSync(f)) return send(res, 404, {});
      res.writeHead(200, { "Content-Type": f.endsWith(".js") ? "text/javascript" : "text/html" });
      return res.end(fs.readFileSync(f));
    }
    if (u.pathname === "/api/version") return send(res, 200, { version: ver });
    if (u.pathname === "/api/me") return send(res, 200, { user: "test", shopifyWrites: false });
    if (u.pathname === "/api/doc" && req.method === "GET") return send(res, 200, { exists: docs.has(p), data: docs.get(p) ?? null });
    if (u.pathname === "/api/doc" && req.method === "PUT") { docs.set(p, json); ver++; return send(res, 200, { version: ver }); }
    if (u.pathname === "/api/doc" && req.method === "DELETE") { docs.delete(p); ver++; return send(res, 200, { version: ver }); }
    if (u.pathname === "/api/collection") return send(res, 200, { docs: [...docs].filter(([k]) => parent(k) === p).map(([k, v]) => ({ id: k.split("/").pop(), data: v })) });
    if (u.pathname === "/api/alerts/negative") return send(res, 200, { stores: [...docs].filter(([k]) => k.startsWith("alerts/negative-")).map(([, v]) => v) });
    if (u.pathname === "/api/sync" && req.method === "POST") return send(res, 200, { started: true });
    if (u.pathname === "/api/sync") return send(res, 200, { running: {}, last: [] });
    if (u.pathname === "/api/shopify/info") { calls.push(["info", json]); return send(res, 200, { name: json.store, domain: json.store }); }
    if (u.pathname === "/api/shopify/graphql") {
      calls.push(["gql", json]);
      if (/^\s*mutation/.test(json.query)) return send(res, 403, { error: "Shopify stock changes are switched off in this version of Stock Desk (testing). Nothing was changed." });
      return send(res, 200, { data: { nodes: [] } });
    }
    send(res, 404, { error: "not found" });
  })
  .listen(Number(process.argv[2] || 4321), () => console.log("mock on", process.argv[2] || 4321));
