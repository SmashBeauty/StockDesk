// Shopify Admin API client for one store, using the client credentials grant
// (Dev Dashboard app in the same Shopify organization as the store).
// Tokens last 24 hours and are refreshed automatically.
import { config } from "./config.js";
import { getShopToken, saveShopToken } from "./db.js";

export const SCOPES = "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_reports";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Shopify {
  constructor(store) {
    this.store = store;
    this.token = null;
    this.expiresAt = 0;
    this.info = null;
  }

  get base() {
    // SHOPIFY_TEST_BASE is only for local tests against a mock server.
    if (process.env.SHOPIFY_TEST_BASE) return `${process.env.SHOPIFY_TEST_BASE}/${this.store.shop}/admin`;
    return `https://${this.store.shop}.myshopify.com/admin`;
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt - 5 * 60_000) return this.token;
    // 1) Token from installing the app on the store (Settings → "Connect store" in Stock Desk).
    const saved = await getShopToken(this.store.id).catch(() => null);
    if (saved) {
      const exp = saved.expires_at ? new Date(saved.expires_at).getTime() : Infinity;
      if (Date.now() < exp - 5 * 60_000) {
        this.token = saved.access_token;
        this.expiresAt = exp;
        return this.token;
      }
      if (saved.refresh_token) {
        const res = await fetch(`${this.base}/oauth/access_token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            client_id: this.store.clientId,
            client_secret: this.store.clientSecret,
            grant_type: "refresh_token",
            refresh_token: saved.refresh_token,
          }),
        });
        if (res.ok) {
          const t = await res.json();
          await saveShopToken(this.store.id, this.store.shop, t);
          this.token = t.access_token;
          this.expiresAt = t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : Infinity;
          return this.token;
        }
        throw new Error(`Shopify connection for ${this.store.shop} has expired (${res.status}). Open Stock Desk → Settings and press "Connect ${this.store.id}" again.`);
      }
    }
    // 2) Client credentials grant (works when the app and store share a Shopify organization).
    const res = await fetch(`${this.base}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.store.clientId,
        client_secret: this.store.clientSecret,
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Shopify sign-in failed for ${this.store.shop} (${res.status}): ${text}. Open Stock Desk and use "Connect ${this.store.id}" to install the app on the store.`);
    }
    const j = await res.json();
    this.token = j.access_token;
    this.expiresAt = Date.now() + (Number(j.expires_in) || 86399) * 1000;
    return this.token;
  }

  // Raw GraphQL call. Returns Shopify's {data, errors, extensions} body.
  async raw(query, variables) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/api/${config.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.getToken() },
        body: JSON.stringify({ query, variables: variables || {} }),
      });
      if (res.status === 401 && attempt < 1) {
        this.token = null;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await sleep(Number(res.headers.get("retry-after") || 0) * 1000 || 1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`Shopify request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      const throttled = (body.errors || []).some((e) => e?.extensions?.code === "THROTTLED");
      if (throttled && attempt < 8) {
        const cost = body.extensions?.cost;
        const need = cost ? cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable : 100;
        const rate = cost?.throttleStatus?.restoreRate || 50;
        await sleep(Math.max(1000, (need / rate) * 1000 + 250));
        continue;
      }
      // Ease off when the bucket is nearly empty.
      const ts = body.extensions?.cost?.throttleStatus;
      if (ts && ts.currentlyAvailable < ts.maximumAvailable * 0.15) await sleep(1000);
      return body;
    }
  }

  async gql(query, variables) {
    const body = await this.raw(query, variables);
    if (!body.data || (body.errors && body.errors.length)) {
      throw new Error("Shopify query failed: " + JSON.stringify(body.errors || body).slice(0, 400));
    }
    return body.data;
  }

  async shopInfo() {
    if (this.info) return this.info;
    const d = await this.gql(`{ shop { name myshopifyDomain primaryDomain { host } } }`);
    const host = (d.shop.primaryDomain?.host || d.shop.myshopifyDomain || "").toLowerCase();
    this.info = { name: d.shop.name, domain: host, myshopifyDomain: d.shop.myshopifyDomain };
    return this.info;
  }

  // ShopifyQL → {columns:[{name}], rows:[[...]]} (same shape the page expects).
  async shopifyql(q) {
    const d = await this.gql(
      `query($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name } rows } } }`,
      { q }
    );
    const r = d.shopifyqlQuery;
    if (r.parseErrors && r.parseErrors.length) throw new Error("ShopifyQL: " + r.parseErrors.join("; "));
    const cols = (r.tableData?.columns || []).map((c) => c.name);
    const rows = (r.tableData?.rows || []).map((row) => (Array.isArray(row) ? row : cols.map((c) => row[c])));
    return { columns: cols.map((name) => ({ name })), rows };
  }
}

const clients = new Map();
export function clientFor(storeId) {
  const s = config.stores.find((x) => x.id === storeId);
  if (!s) return null;
  if (!clients.has(s.id)) clients.set(s.id, new Shopify(s));
  return clients.get(s.id);
}

// Find the configured store whose primary domain is `domain` (the page's store key).
export async function clientForDomain(domain) {
  const want = String(domain || "").toLowerCase();
  for (const s of config.stores) {
    const c = clientFor(s.id);
    try {
      const info = await c.shopInfo();
      if (info.domain === want || info.myshopifyDomain === want) return c;
    } catch {
      /* that store isn't reachable; keep looking */
    }
  }
  return null;
}
