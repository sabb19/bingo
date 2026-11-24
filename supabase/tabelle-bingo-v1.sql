-- Bingo dei Game Awards: tabelle, regole di sicurezza e live
create table public.giocatori (
  id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  nome text not null check (char_length(nome) between 1 and 24),
  cartella smallint[] not null check (array_length(cartella,1) = 16),
  segni boolean[] not null check (array_length(segni,1) = 16),
  linee smallint not null default 0 check (linee between 0 and 10),
  piena boolean not null default false,
  primo_bingo_at timestamptz,
  aggiornato_at timestamptz not null default now()
);
alter table public.giocatori enable row level security;
create policy "tutti i loggati vedono i giocatori" on public.giocatori for select to authenticated using (true);
create policy "ognuno crea la sua cartella" on public.giocatori for insert to authenticated with check ((select auth.uid()) = id);
create policy "ognuno aggiorna la sua cartella" on public.giocatori for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "ognuno cancella la sua cartella" on public.giocatori for delete to authenticated using ((select auth.uid()) = id);

create table public.regia (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.regia enable row level security;
create policy "vedi se sei in regia" on public.regia for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.sono_regia() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.regia where user_id = (select auth.uid()));
$$;
revoke execute on function public.sono_regia() from anon, public;
grant execute on function public.sono_regia() to authenticated;

create table public.momenti (
  id smallint primary key check (id between 0 and 99),
  acceso_at timestamptz not null default now()
);
alter table public.momenti enable row level security;
create policy "tutti i loggati vedono i momenti" on public.momenti for select to authenticated using (true);
create policy "la regia accende" on public.momenti for insert to authenticated with check ((select public.sono_regia()));
create policy "la regia spegne" on public.momenti for delete to authenticated using ((select public.sono_regia()));

create or replace function public.azzera_serata() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sono_regia() then raise exception 'solo la regia'; end if;
  delete from public.momenti where true;
  update public.giocatori set primo_bingo_at = null, linee = 0, piena = false, segni = array_fill(false, array[16]) where true;
end $$;
revoke execute on function public.azzera_serata() from anon, public;
grant execute on function public.azzera_serata() to authenticated;

alter publication supabase_realtime add table public.giocatori, public.momenti;
