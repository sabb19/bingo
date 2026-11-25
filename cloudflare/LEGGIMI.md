# Bingo su Cloudflare

Versione dell'app che gira tutta su Cloudflare (piano gratuito), senza Supabase.

- `src/worker.js`: il server. Serve il sito (`public/`) e le richieste `/api/*`.
  Tutta la serata (giocatori, momenti, admin, sessioni) sta in un unico Durable Object `Serata`,
  quindi le richieste passano in fila e non ci sono corse tra pronostici e conferme.
  Le regole sono le stesse del database Supabase v8 (max 8 pronostici, scelte chiuse, momenti bloccati, serata finita, admin per email).
- `public/`: l'app v33. `cloud.js` offre all'app gli stessi comandi del client Supabase.
- Accesso: "Accedi con Google" in modalità OpenID (id_token firmato da Google, verificato dal server). Nessun segreto da custodire.
  Nel client OAuth Google "Bingo tga" va autorizzato l'URI di reindirizzamento `https://<indirizzo del worker>/api/auth/google/fine`.

Pubblicazione: Cloudflare Workers Builds collegato al repo, cartella radice `cloudflare`, comando `npx wrangler deploy`.
Prove in locale: `npx wrangler dev --var PROVA:1` (abilita `/api/auth/prova`, mai online).
