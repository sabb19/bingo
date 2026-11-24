# Modifiche al database

Ogni file in `migrations/` è una modifica del database, applicata da GitHub (workflow "Aggiorna database") in ordine di numero, una sola volta.

- La v1 (`tabelle-bingo-v1.sql`) è già sul database dal 24/11 e per questo non è qui.
- Per una nuova modifica: un file nuovo con numero più alto (es. `20261125120000_cosa_fa.sql`). Mai cambiare un file già applicato.
- I file `*-v2..v5.sql` in questa cartella sono le copie originali, tenute come archivio.
