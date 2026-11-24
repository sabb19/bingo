-- Bingo v8: admin riconosciuti dalla loro email Google.
-- L'admin principale aggiunge e toglie gli altri admin dalla sezione "Admin" del pannello.
create table if not exists public.admin_email (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  principale boolean not null default false,
  aggiunto_da text,
  aggiunto_at timestamptz not null default now()
);
alter table public.admin_email enable row level security; -- nessuna policy: si legge e si scrive solo con le funzioni qui sotto
insert into public.admin_email (email, principale) values ('sabrinamontella02@gmail.com', true)
  on conflict (email) do update set principale = true;

-- email dell'utente collegato (lo dà il login Google)
create or replace function public.mia_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', ''));
$$;

-- è admin chi è nella tabella regia oppure ha l'email nella lista admin
create or replace function public.sono_regia() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.regia where user_id = (select auth.uid()))
      or exists (select 1 from public.admin_email a where a.email = public.mia_email() and a.email <> '');
$$;

create or replace function public.sono_principale() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_email a where a.email = public.mia_email() and a.principale);
$$;

create or replace function public.admin_lista() returns table (email text, principale boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.sono_regia() then raise exception 'solo la regia'; end if;
  return query select a.email, a.principale from public.admin_email a order by a.principale desc, a.aggiunto_at;
end $$;

create or replace function public.aggiungi_admin(nuova text) returns void
language plpgsql security definer set search_path = '' as $$
declare e text := lower(trim(nuova));
begin
  if not public.sono_principale() then raise exception 'solo l''admin principale'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email non valida'; end if;
  if (select count(*) from public.admin_email) >= 20 then raise exception 'troppi admin'; end if;
  insert into public.admin_email (email, aggiunto_da) values (e, public.mia_email()) on conflict (email) do nothing;
end $$;

create or replace function public.togli_admin(vecchia text) returns void
language plpgsql security definer set search_path = '' as $$
declare e text := lower(trim(vecchia));
begin
  if not public.sono_principale() then raise exception 'solo l''admin principale'; end if;
  delete from public.admin_email where email = e and not principale;
end $$;

revoke execute on function public.mia_email() from public, anon;
revoke execute on function public.sono_principale() from public, anon;
revoke execute on function public.admin_lista() from public, anon;
revoke execute on function public.aggiungi_admin(text) from public, anon;
revoke execute on function public.togli_admin(text) from public, anon;
grant execute on function public.sono_principale() to authenticated;
grant execute on function public.admin_lista() to authenticated;
grant execute on function public.aggiungi_admin(text) to authenticated;
grant execute on function public.togli_admin(text) to authenticated;
grant execute on function public.mia_email() to authenticated;
