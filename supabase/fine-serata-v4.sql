-- Bingo Game Awards: chiusura serata (podio). DA ESEGUIRE dopo gestione-scelte-v3.sql.
alter table public.serata add column if not exists finita boolean not null default false;

-- a serata chiusa niente più pronostici e niente più momenti
create or replace function public.blocca_a_serata_finita() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select finita from public.serata where id = 1), false) then raise exception 'serata chiusa'; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists blocca_momenti_finita on public.momenti;
create trigger blocca_momenti_finita before insert or delete on public.momenti for each row execute function public.blocca_a_serata_finita();

-- l'azzeramento riapre anche la serata
create or replace function public.azzera_serata() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sono_regia() then raise exception 'solo la regia'; end if;
  update public.serata set scelte_aperte = true, finita = false, aggiornato_at = now() where id = 1;
  delete from public.momenti where true;
  update public.giocatori set primo_bingo_at = null, linee = 0, piena = false, segni = array_fill(false, array[16]) where true;
end $$;
