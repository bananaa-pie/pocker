-- Покерный таймер — схема базы для облачной синхронизации (Supabase / Postgres).
-- Выполните это ОДИН раз в Supabase → SQL Editor → New query → Run.
-- Модель: один пользователь = один клуб. Данные (ростер + архив турниров)
-- принадлежат клубу. Доступ к чужому клубу можно выдать по «коду клуба».

-- ─────────────────────────────────────────────────────────────────────────
-- Таблицы
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.clubs (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'Мой клуб',
  code       text not null unique,          -- код для шаринга на другое устройство/со-ведущему
  roster     jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- участники клуба (кому выдан доступ по коду); владелец имеет доступ всегда
create table if not exists public.club_members (
  club_id uuid not null references public.clubs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (club_id, user_id)
);

create table if not exists public.tournaments (
  id         text primary key,              -- id генерирует клиент (совпадает с локальным)
  club_id    uuid not null references public.clubs (id) on delete cascade,
  played_at  timestamptz not null default now(),
  bank       integer not null default 0,
  entries    integer not null default 0,
  payload    jsonb not null,                -- полная запись турнира {date,bank,entries,players:[...]}
  created_at timestamptz not null default now()
);
create index if not exists tournaments_club_idx on public.tournaments (club_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Доступ: помощник (SECURITY DEFINER, чтобы не рекурсировать RLS)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.has_club_access(cid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from clubs c where c.id = cid and c.owner = auth.uid())
      or exists (select 1 from club_members m where m.club_id = cid and m.user_id = auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────
alter table public.clubs         enable row level security;
alter table public.club_members  enable row level security;
alter table public.tournaments   enable row level security;

drop policy if exists clubs_select on public.clubs;
create policy clubs_select on public.clubs for select using (has_club_access(id));
drop policy if exists clubs_insert on public.clubs;
create policy clubs_insert on public.clubs for insert with check (owner = auth.uid());
drop policy if exists clubs_update on public.clubs;
create policy clubs_update on public.clubs for update using (has_club_access(id));
drop policy if exists clubs_delete on public.clubs;
create policy clubs_delete on public.clubs for delete using (owner = auth.uid());

drop policy if exists members_select on public.club_members;
create policy members_select on public.club_members for select using (user_id = auth.uid() or has_club_access(club_id));
drop policy if exists members_delete on public.club_members;
create policy members_delete on public.club_members for delete using (user_id = auth.uid());

drop policy if exists tour_all on public.tournaments;
create policy tour_all on public.tournaments for all
  using (has_club_access(club_id)) with check (has_club_access(club_id));

-- ─────────────────────────────────────────────────────────────────────────
-- RPC: получить (или создать) свой клуб
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.ensure_club()
returns public.clubs language plpgsql security definer set search_path = public as $$
declare c public.clubs;
begin
  select * into c from clubs where owner = auth.uid() limit 1;
  if not found then
    insert into clubs (owner, code)
      values (auth.uid(), upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)))
      returning * into c;
  end if;
  return c;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- RPC: присоединиться к клубу по коду (для со-ведущего / другого устройства)
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.join_club(club_code text)
returns public.clubs language plpgsql security definer set search_path = public as $$
declare c public.clubs;
begin
  select * into c from clubs where code = upper(club_code) limit 1;
  if not found then raise exception 'Клуб с таким кодом не найден'; end if;
  insert into club_members (club_id, user_id) values (c.id, auth.uid())
    on conflict do nothing;
  return c;
end;
$$;

grant execute on function public.ensure_club()          to authenticated;
grant execute on function public.join_club(text)        to authenticated;
grant execute on function public.has_club_access(uuid)  to authenticated;
