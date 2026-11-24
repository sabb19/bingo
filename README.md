# Bingo dei Game Awards

Web app di Side Questers per la watch party dei The Game Awards 2026.

- **Intro:** la mascotte entra a passi e il titolo cade lettera per lettera; si parte con "Premi start".
- **Accesso:** con Google, tramite Supabase. Ogni ospite ha una cartella 4x4 salvata sul suo account.
- **Telefono:** riga, colonna o diagonale completa = BINGO, che arriva da solo sullo schermo grande. I momenti accesi dalla regia compaiono con un pallino viola.
- **Regia:** `#regia` in fondo all'indirizzo. Muro dei momenti (lo modifica solo chi è nella tabella `regia`), QR per entrare e albo dei bingo in diretta.
- **Debug:** `debug.html` è la stessa app con un pannello di prova.

Il database è descritto in `supabase/tabelle-bingo-v1.sql`.
