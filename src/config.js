// All settings come from environment variables (set in Render, never committed).
const env = process.env;

function storeFromEnv(prefix) {
  const shop = (env[`${prefix}_SHOP`] || "").trim().replace(/\.myshopify\.com$/i, "");
  const clientId = (env[`${prefix}_CLIENT_ID`] || "").trim();
  const clientSecret = (env[`${prefix}_CLIENT_SECRET`] || "").trim();
  if (!shop || !clientId || !clientSecret) return null;
  return { id: prefix.toLowerCase(), shop, clientId, clientSecret };
}

export const config = {
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL || "",
  // Shopify Admin API version used for every call.
  apiVersion: env.SHOPIFY_API_VERSION || "2026-10",
  // Logins: comma-separated "name:password" pairs, e.g. "owner:xxxx,staff:yyyy".
  users: (env.APP_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(":");
      return { name: s.slice(0, i), password: s.slice(i + 1) };
    })
    .filter((u) => u.name && u.password),
  sessionSecret: env.SESSION_SECRET || "",
  // Key for scripts/automation (Claude's invoice → PO workflow). Sent as "Authorization: Bearer <key>".
  apiKey: env.API_KEY || "",
  // Stock changes in Shopify (receiving, adjustments, counts) stay off until this is "true".
  allowShopifyWrites: String(env.ALLOW_SHOPIFY_WRITES || "").toLowerCase() === "true",
  stores: [storeFromEnv("SMASH"), storeFromEnv("VENERATE")].filter(Boolean),
};

export function assertServerConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.sessionSecret || config.sessionSecret.length < 16) missing.push("SESSION_SECRET (16+ characters)");
  if (!config.users.length) missing.push("APP_USERS");
  if (missing.length) throw new Error("Missing settings: " + missing.join(", "));
}
