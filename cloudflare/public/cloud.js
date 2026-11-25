// Collegamento dell'app al server Cloudflare.
// Offre gli stessi comandi che l'app usava con Supabase (from, rpc, channel, auth), così il resto dell'app non cambia.
(function () {
  const H = { "content-type": "application/json", "x-bingo": "1" };
  async function post(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: H, body: JSON.stringify(body), credentials: "same-origin" });
      const d = await r.json().catch(() => ({ data: null, error: { message: "risposta non valida (" + r.status + ")" } }));
      if (r.status === 401) setTimeout(() => auths.forEach(fn => fn("SIGNED_OUT", null)), 0);
      return d;
    } catch (e) { return { data: null, error: { message: "manca la rete" } }; }
  }
  function q(t) {
    let op = "sel", val = null, f = null, one = false;
    const run = () => post("/api/q", { t, op, val, f, one });
    const api = {
      select() { return api }, eq(k, v) { f = [k, v]; return api },
      maybeSingle() { one = true; return run() }, single() { one = true; return run() },
      upsert(r) { op = "upsert"; val = r; return api }, update(p) { op = "update"; val = p; return api },
      insert(r) { op = "insert"; val = r; return run() }, delete() { op = "delete"; return api },
      then(res, rej) { return run().then(res, rej) }
    };
    return api;
  }
  const auths = [];
  // errore portato indietro dalla pagina di accesso Google
  try {
    const u = new URL(location.href), e = u.searchParams.get("errore_accesso");
    if (e) { window.__erroreAccesso = e; u.searchParams.delete("errore_accesso"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
  } catch (e) {}
  const client = {
    auth: {
      onAuthStateChange(fn) { auths.push(fn) },
      async getSession() { const d = await post("/api/me", {}); return { data: { session: d && d.data ? { user: d.data.user } : null } } },
      async signInWithOAuth() { location.replace("/api/auth/google/start?torna=" + encodeURIComponent(location.hash || "")); return { error: null } }, // v39: replace, così "indietro" non riporta alla vecchia pagina di accesso
      async signOut() { await post("/api/logout", {}); auths.forEach(fn => fn("SIGNED_OUT", null)); return { error: null } }
    },
    rpc: (n, arg) => post("/api/rpc", { n, arg: arg || {} }),
    from: q,
    removeChannel(c) { if (c && c.chiudi) c.chiudi() },
    channel() {
      const subs = []; let ws = null, ping = null, chiuso = false, cb = null;
      const c = {
        on(_e, o, fn) { subs.push({ t: o.table, fn }); return c },
        subscribe(fn) {
          cb = fn;
          const tv = /^#(classifica|regia|admin)$/.test(location.hash) ? "?tv=1" : "";
          try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live" + tv); }
          catch (e) { setTimeout(() => cb && cb("CHANNEL_ERROR"), 0); return c }
          ws.onopen = () => { ws.send(JSON.stringify({ sub: [...new Set(subs.map(s => s.t))] })); ping = setInterval(() => { try { ws.send("ping") } catch (e) {} }, 25000) };
          ws.onmessage = ev => {
            if (ev.data === "pong") return;
            let d; try { d = JSON.parse(ev.data) } catch (e) { return }
            if (d.ok === "SUBSCRIBED") { cb && cb("SUBSCRIBED"); return }
            if (d.t) subs.forEach(s => s.t === d.t && s.fn({ table: d.t }));
          };
          ws.onclose = () => { clearInterval(ping); if (!chiuso && cb) cb("CLOSED") };
          return c;
        },
        chiudi() { chiuso = true; clearInterval(ping); try { ws && ws.close() } catch (e) {} }
      };
      return c;
    }
  };
  window.supabase = { createClient: () => client };
})();
