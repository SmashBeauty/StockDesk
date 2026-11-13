// Render cron job entry point: sync every configured store, then exit.
import { migrate, pool } from "./db.js";
import { syncAll } from "./sync.js";
import { config } from "./config.js";

const t0 = Date.now();
try {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!config.stores.length) throw new Error("No stores set up (SMASH_* / VENERATE_* settings)");
  await migrate();
  const out = await syncAll((m) => console.log(new Date().toISOString(), m));
  console.log(JSON.stringify(out));
  console.log(`Finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  await pool.end();
  process.exit(out.some((x) => x.error) ? 1 : 0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
