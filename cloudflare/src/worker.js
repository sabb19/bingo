// Bingo Game Awards su Cloudflare.
// Il Worker serve il sito (cartella public) e manda le richieste /api/* all'unica "serata":
// un Durable Object che tiene giocatori, momenti, admin e sessioni, e la diretta via WebSocket.
// Un solo oggetto per tutta la serata = ogni richiesta passa in fila, niente corse tra pronostici e conferme.
import { DurableObject } from "cloudflare:workers";

const PRINCIPALE = "sabrinamontella02@gmail.com";
const N = 16, MAXP = 8, MAX_ADMIN = 20;
const SESS_GIORNI = 60;
const TAVOLE = ["giocatori", "momenti", "serata", "esclusi"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      // v38: la serata vive nell'Unione Europea (giurisdizione "eu": dati salvati ed elaborati solo in UE)
      const ns = env.PROVA === "1" ? env.SERATA : env.SERATA.jurisdiction("eu"); // in locale (prove) la giurisdizione non esiste
      const stub = ns.get(ns.idFromName("serata"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// ---------- piccoli aiuti ----------
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
const err = (message, status = 400) => json({ data: null, error: { message } }, status);
const ok = (data = null) => json({ data, error: null });
const now = () => new Date().toISOString();
const rnd = (n = 32) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
const copia = o => JSON.parse(JSON.stringify(o));
function cookie(req, nome) {
  const c = req.headers.get("cookie") || "";
  for (const p of c.split(/;\s*/)) { const i = p.indexOf("="); if (i > 0 && p.slice(0, i) === nome) return decodeURIComponent(p.slice(i + 1)); }
  return null;
}
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length <= 200;

// verifica il "biglietto" (id_token) che Google firma dopo l'accesso: firma RSA, chi l'ha emesso, per quale app, scadenza, nonce
let jwks = null, jwksAt = 0;
async function chiaviGoogle(forza) {
  if (!jwks || forza || Date.now() - jwksAt > 3600e3) {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!r.ok) throw new Error("chiavi Google non raggiungibili");
    jwks = (await r.json()).keys; jwksAt = Date.now();
  }
  return jwks;
}
async function verificaGoogle(token, clientId, nonce) {
  const parti = String(token || "").split(".");
  if (parti.length !== 3) throw new Error("biglietto non valido");
  const head = JSON.parse(new TextDecoder().decode(b64u(parti[0])));
  const body = JSON.parse(new TextDecoder().decode(b64u(parti[1])));
  if (head.alg !== "RS256") throw new Error("firma non supportata");
  let k = (await chiaviGoogle()).find(x => x.kid === head.kid);
  if (!k) k = (await chiaviGoogle(true)).find(x => x.kid === head.kid);
  if (!k) throw new Error("chiave sconosciuta");
  const key = await crypto.subtle.importKey("jwk", { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valida = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parti[2]), new TextEncoder().encode(parti[0] + "." + parti[1]));
  if (!valida) throw new Error("firma sbagliata");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(body.iss)) throw new Error("emittente sbagliato");
  if (body.aud !== clientId) throw new Error("app sbagliata");
  if (!(body.exp * 1000 > Date.now() - 60e3)) throw new Error("accesso scaduto, riprova");
  if (!nonce || body.nonce !== nonce) throw new Error("accesso non riconosciuto, riprova");
  if (!body.sub) throw new Error("utente mancante");
  return body;
}

export class Serata extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const tutto = await ctx.storage.list();
      this.giocatori = new Map(); this.esclusi = new Map(); this.sess = new Map();
      this.momenti = tutto.get("momenti") || {};           // id -> acceso_at
      this.serata = tutto.get("serata") || { id: 1, scelte_aperte: true, finita: false, aggiornato_at: now() };
      this.admin = tutto.get("admin") || [{ email: PRINCIPALE, principale: true, aggiunto_at: now() }];
      for (const [k, v] of tutto) {
        if (k.startsWith("g:")) this.giocatori.set(k.slice(2), v);
        else if (k.startsWith("x:")) this.esclusi.set(k.slice(2), v);
        else if (k.startsWith("s:")) this.sess.set(k.slice(2), v);
      }
      // le sessioni scadute si buttano all'avvio
      const via = [];
      for (const [t, s] of this.sess) if (s.exp < Date.now()) { this.sess.delete(t); via.push("s:" + t); }
      if (via.length) await ctx.storage.delete(via);
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    });
  }

  // ---------- chi sei ----------
  utente(req) {
    const t = cookie(req, "sq_sess");
    if (!t) return null;
    const s = this.sess.get(t);
    if (!s || s.exp < Date.now()) return null;
    return s;
  }
  isRegia(u) { return !!u && this.admin.some(a => a.email === u.email); }
  isPrincipale(u) { return !!u && this.admin.some(a => a.email === u.email && a.principale); }

  // ---------- diretta ----------
  avvisa(t) {
    const msg = JSON.stringify({ t });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.sub && a.sub.includes(t)) { try { ws.send(msg); } catch (e) {} }
    }
  }
  webSocketMessage(ws, m) {
    try {
      const d = JSON.parse(m);
      if (Array.isArray(d.sub)) {
        const a = ws.deserializeAttachment() || {};
        a.sub = d.sub.filter(t => TAVOLE.includes(t));
        // la tabella giocatori in diretta solo per admin e schermo TV (tanti messaggi): i giocatori rileggono quando serve
        if (!a.regia && !a.tv) a.sub = a.sub.filter(t => t !== "giocatori");
        ws.serializeAttachment(a);
        ws.send(JSON.stringify({ ok: "SUBSCRIBED" }));
      }
    } catch (e) {}
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "ciao"); } catch (e) {} }
  webSocketError() {}

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/api/auth/google/start") return this.inizioGoogle(req, url);
      if (p === "/api/auth/google/fine") return await this.fineGoogle(req, url);
      if (p === "/api/auth/prova" && this.env.PROVA === "1") return await this.accessoProva(req, url);
      if (p === "/api/logout") return await this.esci(req);
      const u = this.utente(req);
      if (p === "/api/me") return ok(u ? { user: { id: u.id, email: u.email, user_metadata: { full_name: u.nome } } } : null);
      if (!u) return err("non sei collegata: rifai l'accesso", 401);
      if (p === "/api/live") {
        if (req.headers.get("upgrade") !== "websocket") return err("serve un websocket", 426);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ id: u.id, regia: this.isRegia(u), tv: url.searchParams.get("tv") === "1", sub: [] });
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (req.method !== "POST") return err("metodo non permesso", 405);
      if (req.headers.get("x-bingo") !== "1") return err("richiesta non valida", 403); // niente invii da altri siti
      const body = await req.json();
      if (p === "/api/q") return await this.query(u, body);
      if (p === "/api/rpc") return await this.rpc(u, body.n, body.arg || {});
      return err("non trovato", 404);
    } catch (e) {
      return err(String((e && e.message) || e), 400);
    }
  }

  // ---------- accesso con Google (OpenID, senza segreti: Google firma un biglietto e noi lo verifichiamo) ----------
  inizioGoogle(req, url) {
    const nonce = rnd(16), state = rnd(16);
    const torna = (url.searchParams.get("torna") || "").replace(/[^a-z#]/gi, "").slice(0, 20);
    const redirect = url.origin + "/api/auth/google/fine";
    const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    g.search = new URLSearchParams({
      client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "id_token",
      response_mode: "form_post", scope: "openid email profile", nonce, state, prompt: "select_account",
    });
    // Google rimanda qui con un POST da un altro sito: il cookie deve essere SameSite=None per tornare indietro
    const c = `sq_auth=${encodeURIComponent(nonce + "." + state + "." + torna)}; Path=/api/auth; Max-Age=900; HttpOnly; Secure; SameSite=None`;
    return new Response(null, { status: 302, headers: { location: g.toString(), "set-cookie": c, "cache-control": "no-store" } });
  }
  async fineGoogle(req, url) {
    const indietro = (msg) => new Response(null, { status: 303, headers: { location: "/?errore_accesso=" + encodeURIComponent(msg), "cache-control": "no-store",
      "set-cookie": "sq_auth=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=None" } });
    if (req.method !== "POST") return indietro("accesso annullato");
    const form = await req.formData();
    if (form.get("error")) return indietro("accesso annullato");
    const [nonce, state, torna] = (cookie(req, "sq_auth") || "").split(".");
    if (!state || form.get("state") !== state) return indietro("accesso scaduto, riprova");
    let g;
    try { g = await verificaGoogle(form.get("id_token"), this.env.GOOGLE_CLIENT_ID, nonce); }
    catch (e) { return indietro(e.message); }
    if (g.email_verified === false) return indietro("email Google non verificata");
    const u = { id: "g" + g.sub, email: String(g.email || "").toLowerCase(), nome: String(g.given_name || g.name || "").slice(0, 40) };
    const t = await this.nuovaSessione(u);
    return new Response(null, { status: 303, headers: [
      ["location", "/" + (torna || "")], ["cache-control", "no-store"],
      ["set-cookie", "sq_auth=; Path=/api/auth; Max-Age=0; HttpOnly; Secure; SameSite=None"],
      ["set-cookie", `sq_sess=${t}; Path=/; Max-Age=${SESS_GIORNI * 86400}; HttpOnly; Secure; SameSite=Lax`],
    ] });
  }
  async nuovaSessione(u) {
    const t = rnd(32), s = { ...u, exp: Date.now() + SESS_GIORNI * 86400e3 };
    this.sess.set(t, s); await this.ctx.storage.put("s:" + t, s);
    return t;
  }
  // solo in locale per le prove automatiche (PROVA=1 non è mai impostato online)
  async accessoProva(req, url) {
    const email = (url.searchParams.get("email") || "").toLowerCase();
    const u = { id: "p" + email.replace(/[^a-z0-9]/g, ""), email, nome: url.searchParams.get("nome") || email.split("@")[0] };
    const t = await this.nuovaSessione(u);
    return json({ ok: true }, 200, { "set-cookie": `sq_sess=${t}; Path=/; HttpOnly; SameSite=Lax` });
  }
  async esci(req) {
    const t = cookie(req, "sq_sess");
    if (t && this.sess.has(t)) { this.sess.delete(t); await this.ctx.storage.delete("s:" + t); }
    return json({ data: null, error: null }, 200, { "set-cookie": "sq_sess=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
  }

  // ---------- regole (le stesse del database Supabase v8) ----------
  controllaPronostici(vecchi, nuovi) {
    if (!Array.isArray(nuovi) || nuovi.length !== N || !nuovi.every(v => typeof v === "boolean")) throw new Error("pronostici non validi");
    const cambiati = nuovi.some((v, i) => v !== !!vecchi[i]);
    if (!cambiati) return;
    if (this.serata.finita) throw new Error("serata finita");
    if (!this.serata.scelte_aperte) throw new Error("scelte chiuse");
    if (nuovi.filter(Boolean).length > MAXP) throw new Error("massimo 8 pronostici");
    for (let i = 0; i < N; i++) if (this.momenti[i] && nuovi[i] !== !!vecchi[i]) throw new Error("momento già successo");
  }
  pulisciNome(n) {
    n = String(n ?? "");
    if (n !== n.trim() || n.length < 1 || n.length > 24 || /[<>]/.test(n)) throw new Error("nome non valido");
    return n;
  }
  pulisciAvatar(a) {
    if (a == null) return {};
    if (typeof a !== "object" || Array.isArray(a) || JSON.stringify(a).length > 500) throw new Error("personaggio non valido");
    const o = {};
    for (const k of ["f", "c", "x"]) if (Number.isInteger(a[k]) && a[k] >= 0 && a[k] < 20) o[k] = a[k];
    return o;
  }
  pulisciCartella(c) {
    if (!Array.isArray(c) || c.length !== N || !c.every(v => Number.isInteger(v) && v >= 0 && v < 100)) throw new Error("cartella non valida");
    return c.slice();
  }
  async salvaGiocatore(g) { this.giocatori.set(g.id, g); await this.ctx.storage.put("g:" + g.id, g); this.avvisa("giocatori"); }

  async query(u, b) {
    const t = b.t, op = b.op, f = Array.isArray(b.f) ? b.f : null, val = b.val;
    if (!TAVOLE.includes(t)) throw new Error("tabella sconosciuta");
    const regia = this.isRegia(u);
    const filtra = rows => f ? rows.filter(r => r[f[0]] === f[1]) : rows;
    const risposta = rows => ok(b.one ? (rows[0] || null) : rows);

    if (op === "sel") {
      if (t === "giocatori") return risposta(filtra([...this.giocatori.values()]).map(copia));
      if (t === "momenti") return risposta(filtra(Object.entries(this.momenti).map(([id, at]) => ({ id: +id, acceso_at: at }))));
      if (t === "serata") return risposta(filtra([copia(this.serata)]));
      if (t === "esclusi") return risposta(filtra([...this.esclusi.values()]).map(copia));
    }

    if (t === "giocatori") {
      if (op === "upsert") { // nuova cartella (o ricomincia la propria)
        if (!val || val.id !== u.id) throw new Error("puoi creare solo la tua cartella");
        if (this.esclusi.has(u.id)) throw new Error("sei stata tolta dalla partita");
        const vecchio = this.giocatori.get(u.id);
        const segni = val.segni;
        this.controllaPronostici(vecchio ? vecchio.segni : Array(N).fill(false), segni);
        const g = { id: u.id, nome: this.pulisciNome(val.nome), avatar: this.pulisciAvatar(val.avatar), cartella: this.pulisciCartella(val.cartella),
          segni: segni.slice(), aggiornato_at: now() };
        await this.salvaGiocatore(g);
        return ok(copia(g));
      }
      if (op === "update") {
        if (!f || f[0] !== "id") throw new Error("aggiornamento non valido");
        const g = this.giocatori.get(f[1]);
        if (!g) return ok(null);
        const mio = f[1] === u.id;
        if (!mio && !regia) throw new Error("non puoi cambiare altri giocatori");
        const n = { ...g };
        if ("nome" in val) n.nome = this.pulisciNome(val.nome);
        if (mio) {
          if ("avatar" in val) n.avatar = this.pulisciAvatar(val.avatar);
          if ("cartella" in val) n.cartella = this.pulisciCartella(val.cartella);
          if ("segni" in val) { this.controllaPronostici(g.segni, val.segni); n.segni = val.segni.slice(); }
        } else if (Object.keys(val).some(k => !["nome", "aggiornato_at"].includes(k))) throw new Error("l'admin può solo rinominare");
        n.aggiornato_at = now();
        await this.salvaGiocatore(n);
        return ok(null);
      }
      if (op === "delete") {
        if (!regia) throw new Error("solo l'admin toglie i giocatori");
        if (!f || f[0] !== "id") throw new Error("non valido");
        if (this.giocatori.delete(f[1])) { await this.ctx.storage.delete("g:" + f[1]); this.avvisa("giocatori"); }
        return ok(null);
      }
    }
    if (t === "momenti") {
      if (!regia) throw new Error("solo l'admin conferma i momenti");
      if (this.serata.finita) throw new Error("serata chiusa");
      if (op === "insert") {
        const id = val && val.id;
        if (!Number.isInteger(id) || id < 0 || id >= N) throw new Error("momento non valido");
        if (!this.momenti[id]) { this.momenti[id] = now(); await this.ctx.storage.put("momenti", this.momenti); this.avvisa("momenti"); }
        return ok(null);
      }
      if (op === "delete") {
        if (!f || f[0] !== "id") throw new Error("non valido");
        if (this.momenti[f[1]]) { delete this.momenti[f[1]]; await this.ctx.storage.put("momenti", this.momenti); this.avvisa("momenti"); }
        return ok(null);
      }
    }
    if (t === "serata" && op === "update") {
      if (!regia) throw new Error("solo l'admin gestisce la serata");
      if ("scelte_aperte" in val) this.serata.scelte_aperte = !!val.scelte_aperte;
      if ("finita" in val) this.serata.finita = !!val.finita;
      this.serata.aggiornato_at = now();
      await this.ctx.storage.put("serata", this.serata); this.avvisa("serata");
      return ok(null);
    }
    if (t === "esclusi") {
      if (!regia) throw new Error("solo l'admin");
      if (op === "insert") {
        const id = String(val && val.user_id || "");
        if (!id) throw new Error("giocatore mancante");
        const e = { user_id: id, nome: String(val.nome || "").slice(0, 24), escluso_at: now() };
        this.esclusi.set(id, e); await this.ctx.storage.put("x:" + id, e); this.avvisa("esclusi");
        return ok(null);
      }
      if (op === "delete") {
        if (!f || f[0] !== "user_id") throw new Error("non valido");
        if (this.esclusi.delete(f[1])) { await this.ctx.storage.delete("x:" + f[1]); this.avvisa("esclusi"); }
        return ok(null);
      }
    }
    throw new Error("operazione non permessa");
  }

  async rpc(u, n, arg) {
    if (n === "sono_regia") return ok(this.isRegia(u));
    if (n === "sono_principale") return ok(this.isPrincipale(u));
    if (n === "admin_lista") {
      if (!this.isRegia(u)) throw new Error("solo la regia");
      return ok(this.admin.slice().sort((a, b) => b.principale - a.principale).map(a => ({ email: a.email, principale: a.principale })));
    }
    if (n === "aggiungi_admin") {
      if (!this.isPrincipale(u)) throw new Error("solo l'admin principale");
      const e = String(arg.nuova || "").trim().toLowerCase();
      if (!emailOk(e)) throw new Error("email non valida");
      if (this.admin.length >= MAX_ADMIN) throw new Error("troppi admin");
      if (!this.admin.some(a => a.email === e)) { this.admin.push({ email: e, principale: false, aggiunto_da: u.email, aggiunto_at: now() }); await this.ctx.storage.put("admin", this.admin); this.aggiornaRegiaSocket(); }
      return ok(null);
    }
    if (n === "togli_admin") {
      if (!this.isPrincipale(u)) throw new Error("solo l'admin principale");
      const e = String(arg.vecchia || "").trim().toLowerCase();
      this.admin = this.admin.filter(a => a.principale || a.email !== e);
      await this.ctx.storage.put("admin", this.admin); this.aggiornaRegiaSocket();
      return ok(null);
    }
    // v38: ognuno può cancellare il proprio account (giocatore e tutti i suoi accessi)
    if (n === "cancella_account") {
      const via = ["g:" + u.id];
      this.giocatori.delete(u.id); // chi era stato tolto dalla serata resta tolto (solo id e nome, per non farlo rientrare)
      for (const [t, s] of this.sess) if (s.id === u.id) { this.sess.delete(t); via.push("s:" + t); }
      for (let i = 0; i < via.length; i += 100) await this.ctx.storage.delete(via.slice(i, i + 100));
      for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment() || {}; if (a.id === u.id) { try { ws.close(1000, "account cancellato"); } catch (e) {} } }
      this.avvisa("giocatori"); this.avvisa("esclusi");
      return ok(null);
    }
    // v38: dopo la serata l'admin principale cancella tutto (giocatori, momenti, esclusi, accessi tranne il suo). La lista admin resta.
    if (n === "svuota_tutto") {
      if (!this.isPrincipale(u)) throw new Error("solo l'admin principale");
      const via = [...this.giocatori.keys()].map(k => "g:" + k).concat([...this.esclusi.keys()].map(k => "x:" + k));
      for (const [t, s] of this.sess) if (s.id !== u.id) { this.sess.delete(t); via.push("s:" + t); }
      this.giocatori.clear(); this.esclusi.clear();
      for (let i = 0; i < via.length; i += 100) await this.ctx.storage.delete(via.slice(i, i + 100));
      this.momenti = {}; this.serata = { id: 1, scelte_aperte: true, finita: false, aggiornato_at: now() };
      await this.ctx.storage.put({ momenti: this.momenti, serata: this.serata });
      this.avvisa("giocatori"); this.avvisa("esclusi"); this.avvisa("momenti"); this.avvisa("serata");
      return ok(null);
    }
    if (n === "azzera_serata") {
      if (!this.isRegia(u)) throw new Error("solo la regia");
      this.serata = { id: 1, scelte_aperte: true, finita: false, aggiornato_at: now() };
      this.momenti = {};
      const put = { serata: this.serata, momenti: this.momenti };
      for (const g of this.giocatori.values()) { g.segni = Array(N).fill(false); put["g:" + g.id] = g; }
      const voci = Object.entries(put);
      for (let i = 0; i < voci.length; i += 100) await this.ctx.storage.put(Object.fromEntries(voci.slice(i, i + 100)));
      this.avvisa("serata"); this.avvisa("momenti"); this.avvisa("giocatori");
      return ok(null);
    }
    throw new Error("funzione sconosciuta");
  }
  aggiornaRegiaSocket() {
    const emails = new Set(this.admin.map(a => a.email));
    const per = new Map([...this.sess.values()].map(s => [s.id, s.email]));
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment() || {}; a.regia = emails.has(per.get(a.id)); ws.serializeAttachment(a); }
  }
}
