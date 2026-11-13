// Import saved data from the old Stock Desk page (purchase orders, adjustments,
// settings, overrides, no-reorder lists) into this app's database.
//
// Usage: DATABASE_URL=... node scripts/import.js <folder>
// <folder> holds JSON files laid out as <collection path>/<doc id>.json, each either the
// document itself or {"data": {...}} (the export format Claude uses).
// Store snapshots ("stores/...") are skipped: the server sync rebuilds them.
import fs from "node:fs";
import path from "node:path";
import { migrate, setDoc, pool } from "../src/db.js";

const root = process.argv[2];
if (!root || !fs.existsSync(root)) {
  console.error("Usage: node scripts/import.js <folder>");
  process.exit(1);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".json")) yield p;
  }
}

await migrate();
let n = 0, skipped = 0;
for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, "/").replace(/\.json$/, "");
  if (rel.startsWith("stores/")) {
    skipped++;
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const data = raw && typeof raw.data === "object" && !Array.isArray(raw.data) && Object.keys(raw).every((k) => ["id", "data", "version", "updatedAt"].includes(k)) ? raw.data : raw;
  await setDoc(rel, data);
  n++;
}
console.log(`Imported ${n} documents (${skipped} store snapshot files skipped).`);
await pool.end();
