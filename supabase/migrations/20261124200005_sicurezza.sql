-- Bingo dei Game Awards, v5: correzioni di sicurezza + gestione giocatori dall'admin
-- Da eseguire DOPO v2, v3 e v4. NON ancora eseguito.

-- 1) Il controllo dei pronostici vale anche quando si CREA la cartella (prima valeva solo sulla modifica)
create or replace function public.controlla_pronostici() returns trigger
language plpgsql security definer set search_path = '' as $$
declare aperte boolean; finita boolean; i int; vecchi boolean[];
begin
  if public.sono_regia() and new.id <> auth.uid() then return new; end if; -- azioni dell'admin su altri
  vecchi := case when tg_op = 'UPDATE' then old.segni else array_fill(false, array[array_length(new.segni,1)]) end;
  if new.segni is distinct from vecchi then
    select s.scelte_aperte, s.finita into aperte, finita from public.serata s where s.id = 1;
    if coalesce(finita, false) then raise exception 'serata finita'; end if;
    if not coalesce(aperte, true) then raise exception 'scelte chiuse'; end if;
    if (select count(*) from unnest(new.segni) s where s) > 8 then raise exception 'massimo 8 pronostici'; end if;
    for i in 0..array_length(new.segni,1)-1 loop
      if exists (select 1 from public.momenti m where m.id = i) and new.segni[i+1] is distinct from vecchi[i+1] then
        raise exception 'momento già successo';
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists controlla_pronostici on public.giocatori;
create trigger controlla_pronostici before insert or update on public.giocatori for each row execute function public.controlla_pronostici();

-- 2) Il giocatore non può più cancellare la sua cartella (si cancellava e ricreava per barare). Lo fa solo l'admin.
drop policy if exists "ognuno cancella la sua cartella" on public.giocatori;
drop policy if exists "admin toglie i giocatori" on public.giocatori;
create policy "admin toglie i giocatori" on public.giocatori for delete to authenticated using ((select public.sono_regia()));

-- 3) L'admin può rinominare qualsiasi giocatore
drop policy if exists "admin rinomina" on public.giocatori;
create policy "admin rinomina" on public.giocatori for update to authenticated using ((select public.sono_regia())) with check ((select public.sono_regia()));

-- 4) Nome e personaggio puliti
alter table public.giocatori drop constraint if exists nome_pulito;
alter table public.giocatori add constraint nome_pulito check (nome = btrim(nome) and nome !~ '[<>]');
alter table public.giocatori drop constraint if exists avatar_piccolo;
alter table public.giocatori add constraint avatar_piccolo check (avatar is null or (jsonb_typeof(avatar) = 'object' and pg_column_size(avatar) < 600));

-- 5) Giocatori tolti dalla serata: non possono ricreare la cartella finché l'admin non li riammette
create table if not exists public.esclusi (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome text,
  escluso_at timestamptz not null default now()
);
alter table public.esclusi enable row level security;
drop policy if exists "tutti vedono gli esclusi" on public.esclusi;
create policy "tutti vedono gli esclusi" on public.esclusi for select to authenticated using (true);
drop policy if exists "admin esclude" on public.esclusi;
create policy "admin esclude" on public.esclusi for insert to authenticated with check ((select public.sono_regia()));
drop policy if exists "admin riammette" on public.esclusi;
create policy "admin riammette" on public.esclusi for delete to authenticated using ((select public.sono_regia()));
drop policy if exists "ognuno crea la sua cartella" on public.giocatori;
create policy "ognuno crea la sua cartella" on public.giocatori for insert to authenticated
  with check ((select auth.uid()) = id and not exists (select 1 from public.esclusi e where e.user_id = (select auth.uid())));
alter publication supabase_realtime add table public.esclusi;
