-- v7: se un giocatore cambia un pronostico nello stesso istante in cui la regia conferma quel momento
-- (o chiude le scelte), uno dei due aspetta l'altro: niente pronostici cambiati "all'ultimo millisecondo".
create or replace function public.controlla_pronostici() returns trigger
language plpgsql security definer set search_path = '' as $$
declare aperte boolean; finita boolean; i int; vecchi boolean[];
begin
  if public.sono_regia() and new.id <> auth.uid() then return new; end if; -- azioni dell'admin su altri
  vecchi := case when tg_op = 'UPDATE' then old.segni else array_fill(false, array[array_length(new.segni,1)]) end;
  if new.segni is distinct from vecchi then
    perform 1 from public.serata where id = 1 for share; -- aspetta se la regia sta confermando un momento o chiudendo le scelte
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

create or replace function public.blocca_a_serata_finita() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.serata where id = 1 for update; -- i pronostici in corso finiscono prima, i successivi vedono il momento
  if coalesce((select finita from public.serata where id = 1), false) then raise exception 'serata chiusa'; end if;
  return coalesce(new, old);
end $$;

revoke execute on function public.controlla_pronostici() from public, anon, authenticated;
revoke execute on function public.blocca_a_serata_finita() from public, anon, authenticated;
