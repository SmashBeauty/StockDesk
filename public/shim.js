// Stand-in for the claude.ai artifact runtime, so the original Stock Desk page runs on
// this server unchanged: window.claude.use("db" | "mcp" | "user" | "downloads").
(function () {
  "use strict";
  const POLL_MS = 15000;
  const api = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401) {
      location.href = "/login";
      throw { code: "needs_reauth", message: "Please sign in again." };
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw { code: res.status === 403 ? "blocked_by_policy" : "tool_error", message: j.error || "Request failed (" + res.status + ")" };
    return j;
  };

  /* ---------- db ---------- */
  const listeners = new Set();
  let lastVersion = null;
  const docSnap = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))) });
  function doc(path) {
    const id = path.split("/").pop();
    return {
      id,
      path,
      async get() {
        const r = await api("GET", "/api/doc?path=" + encodeURIComponent(path));
        return docSnap(id, r.exists ? r.data : null);
      },
      async set(data) {
        await api("PUT", "/api/doc?path=" + encodeURIComponent(path), data);
        poke();
      },
      async delete() {
        await api("DELETE", "/api/doc?path=" + encodeURIComponent(path));
        poke();
      },
      collection: (sub) => collection(path + "/" + sub),
      onSnapshot(next, err) {
        const l = { run: async () => next(await this.get()), err };
        return listen(l);
      },
    };
  }
  function collection(path) {
    return {
      path,
      doc: (id) => doc(path + "/" + id),
      async get() {
        const r = await api("GET", "/api/collection?path=" + encodeURIComponent(path));
        const docs = r.docs.map((d) => docSnap(d.id, d.data));
        return { docs, size: docs.length, empty: !docs.length };
      },
      onSnapshot(next, err) {
        const l = { run: async () => next(await this.get()), err };
        return listen(l);
      },
    };
  }
  function listen(l) {
    listeners.add(l);
    l.run().catch((e) => l.err && l.err(e));
    return () => listeners.delete(l);
  }
  async function refreshAll() {
    for (const l of listeners) {
      try {
        await l.run();
      } catch (e) {
        if (l.err) l.err(e);
      }
    }
  }
  let pokeTimer = null;
  function poke() {
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(check, 400);
  }
  async function check() {
    try {
      const { version } = await api("GET", "/api/version");
      if (lastVersion !== null && version !== lastVersion) await refreshAll();
      lastVersion = version;
    } catch (e) {
      /* offline for a moment; try again next tick */
    }
  }
  setInterval(() => {
    if (!document.hidden) check();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  check();
  const db = { doc, collection };

  /* ---------- Shopify ("mcp") ---------- */
  // The page always asks "which store is connected?" before changing stock and compares it
  // with the store it is working on. window.__sdStore is set to that store just before.
  const mcp = {
    async callTool(server, tool, input) {
      const store = window.__sdStore || "";
      if (tool === "get-shop-info") {
        if (!store) throw { code: "tool_error", message: "Pick a store first." };
        return { payload: await api("POST", "/api/shopify/info", { store }) };
      }
      if (tool === "graphql_query" || tool === "graphql_mutation") {
        return { payload: await api("POST", "/api/shopify/graphql", { store, query: input.query, variables: input.variables || {} }) };
      }
      throw { code: "tool_error", message: "Not available in Stock Desk: " + tool };
    },
  };

  /* ---------- user / downloads ---------- */
  let me = null;
  const meP = api("GET", "/api/me").then((m) => (me = m)).catch(() => null);
  const user = { can: async () => true, me: async () => (await meP) || {} };
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  };

  window.claude = {
    use: async (name) => ({ db, mcp, user, downloads })[name] || null,
  };

  /* ---------- server sync + alerts (used by the patched sync button) ---------- */
  window.StockDeskServer = {
    api,
    meP,
    refreshAll,
    async startSync() {
      return api("POST", "/api/sync", {});
    },
    async syncState() {
      return api("GET", "/api/sync");
    },
    async negatives() {
      return api("GET", "/api/alerts/negative");
    },
  };
})();
