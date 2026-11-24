-- Bingo Game Awards: gestione serata (scelte aperte/chiuse). DA ESEGUIRE quando colleghiamo Supabase, dopo aggiunta-personaggio-v2.sql.
create table if not exists public.serata (
  id smallint primary key default 1 check (id = 1),
  scelte_aperte boolean not null default true,
  aggiornato_at timestamptz not null default now()
);
insert into public.serata (id) values (1) on conflict do nothing;
alter table public.serata enable row level security;
drop policy if exists "tutti leggono la serata" on public.serata;
create policy "tutti leggono la serata" on public.serata for select to authenticated using (true);
drop policy if exists "solo admin cambia la serata" on public.serata;
create policy "solo admin cambia la serata" on public.serata for update to authenticated using ((select public.sono_regia())) with check ((select public.sono_regia()));

-- regole dei pronostici controllate dal database, non solo dall'app
create or replace function public.controlla_pronostici() returns trigger
language plpgsql security definer set search_path = '' as $$
declare aperte boolean; i int;
begin
  if new.segni is distinct from old.segni then
    if public.sono_regia() and new.id <> auth.uid() then return new; end if; -- azzeramento dall'admin
    select scelte_aperte into aperte from public.serata where id = 1;
    if not coalesce(aperte, true) then raise exception 'scelte chiuse'; end if;
    if (select count(*) from unnest(new.segni) s where s) > 8 then raise exception 'massimo 8 pronostici'; end if;
    for i in 0..15 loop
      if exists (select 1 from public.momenti m where m.id = i) and new.segni[i+1] is distinct from old.segni[i+1] then
        raise exception 'momento già successo';
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists controlla_pronostici on public.giocatori;
create trigger controlla_pronostici before update on public.giocatori for each row execute function public.controlla_pronostici();

-- l'azzeramento riapre anche le scelte
create or replace function public.azzera_serata() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sono_regia() then raise exception 'solo la regia'; end if;
  delete from public.momenti where true;
  update public.giocatori set primo_bingo_at = null, linee = 0, piena = false, segni = array_fill(false, array[16]) where true;
  update public.serata set scelte_aperte = true, aggiornato_at = now() where id = 1;
end $$;

alter publication supabase_realtime add table public.serata;
