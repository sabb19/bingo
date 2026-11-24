-- Da eseguire quando colleghiamo Supabase: aggiunge il personaggio pixel ai giocatori
alter table public.giocatori add column if not exists avatar jsonb not null default '{}'::jsonb;
