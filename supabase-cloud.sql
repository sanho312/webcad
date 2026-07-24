-- ============================================================
--  Parti 클라우드 기능 (도면저장·버전·공유·블록·설정·통계·오류·피드백·공지·플랜)
--  Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 하세요. (재실행해도 안전)
-- ============================================================

-- 0) 플랜 등급 (free / pro)
alter table public.profiles add column if not exists plan text not null default 'free';

-- 1) 도면
create table if not exists public.drawings (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null default '새 도면',
  data jsonb not null,
  thumb text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists drawings_owner_idx on public.drawings(owner, updated_at desc);
alter table public.drawings enable row level security;

-- 2) 버전 기록
create table if not exists public.drawing_versions (
  id bigint generated always as identity primary key,
  drawing_id uuid not null references public.drawings(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists dv_idx on public.drawing_versions(drawing_id, id desc);
alter table public.drawing_versions enable row level security;

-- 3) 공유
create table if not exists public.drawing_shares (
  drawing_id uuid not null references public.drawings(id) on delete cascade,
  shared_with uuid not null references auth.users(id) on delete cascade,
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (drawing_id, shared_with)
);
alter table public.drawing_shares enable row level security;

-- 4) 개인 블록 라이브러리
create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique(owner, name)
);
alter table public.user_blocks enable row level security;

-- 5) 설정 동기화
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;

-- 6) 오류 로그
create table if not exists public.error_logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  message text,
  source text,
  ua text,
  created_at timestamptz not null default now()
);
alter table public.error_logs enable row level security;

-- 7) 사용 통계 (일자·이벤트별 집계)
create table if not exists public.usage_stats (
  user_id uuid not null,
  day date not null default current_date,
  event text not null,
  count int not null default 0,
  primary key (user_id, day, event)
);
alter table public.usage_stats enable row level security;

-- 8) 피드백
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  username text,
  message text not null,
  ua text,
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;

-- 9) 공지
create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  message text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

-- ============================================================
--  RLS 정책
--  주의: drawings↔drawing_shares 정책이 서로를 직접 참조하면 무한 재귀가
--  발생하므로, 상호 참조는 security definer 헬퍼 함수로 RLS를 우회한다.
-- ============================================================
create or replace function public.is_drawing_owner(d uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists(select 1 from drawings where id = d and owner = auth.uid());
$$;
create or replace function public.is_shared_with_me(d uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists(select 1 from drawing_shares where drawing_id = d and shared_with = auth.uid());
$$;
create or replace function public.can_edit_shared(d uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists(select 1 from drawing_shares where drawing_id = d and shared_with = auth.uid() and can_edit);
$$;

-- 도면: 소유자 전체권한 / 공유받은 사람은 읽기(+편집권한 시 수정)
drop policy if exists "drawings owner all" on public.drawings;
create policy "drawings owner all" on public.drawings
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "drawings shared read" on public.drawings;
create policy "drawings shared read" on public.drawings for select
  using (public.is_shared_with_me(id));
drop policy if exists "drawings shared edit" on public.drawings;
create policy "drawings shared edit" on public.drawings for update
  using (public.can_edit_shared(id));

-- 버전: 도면 소유자만
drop policy if exists "versions owner" on public.drawing_versions;
create policy "versions owner" on public.drawing_versions
  using (public.is_drawing_owner(drawing_id))
  with check (public.is_drawing_owner(drawing_id));

-- 공유: 도면 소유자가 관리, 공유받은 사람은 자기 항목 조회
drop policy if exists "shares owner manage" on public.drawing_shares;
create policy "shares owner manage" on public.drawing_shares
  using (public.is_drawing_owner(drawing_id))
  with check (public.is_drawing_owner(drawing_id));
drop policy if exists "shares recipient read" on public.drawing_shares;
create policy "shares recipient read" on public.drawing_shares for select
  using (shared_with = auth.uid());

-- 블록/설정: 본인만
drop policy if exists "blocks owner" on public.user_blocks;
create policy "blocks owner" on public.user_blocks
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "settings owner" on public.user_settings;
create policy "settings owner" on public.user_settings
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 오류/통계/피드백: 클라이언트 직접 접근 금지(RPC로만) — 정책 없음 = 차단
-- 공지: 누구나 읽기
drop policy if exists "announcements read" on public.announcements;
create policy "announcements read" on public.announcements for select using (active);
grant select on public.announcements to anon, authenticated;

-- ============================================================
--  RPC 함수
-- ============================================================
-- 도면 저장(신규/갱신) + 버전 스냅샷 + 오래된 버전 정리 + 플랜 한도
create or replace function public.save_drawing(p_id uuid, p_name text, p_data jsonb, p_thumb text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_plan text; v_cnt int; v_owner uuid; v_can boolean;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if p_id is null then
    select plan into v_plan from profiles where id = auth.uid();
    select count(*) into v_cnt from drawings where owner = auth.uid();
    if coalesce(v_plan,'free') = 'free' and v_cnt >= 5 then
      raise exception 'plan_limit';  -- 무료: 도면 5개
    end if;
    insert into drawings(owner, name, data, thumb) values (auth.uid(), coalesce(p_name,'새 도면'), p_data, p_thumb)
    returning id into v_id;
  else
    select owner into v_owner from drawings where id = p_id;
    if v_owner is null then raise exception 'not_found'; end if;
    v_can := (v_owner = auth.uid()) or exists(select 1 from drawing_shares s where s.drawing_id = p_id and s.shared_with = auth.uid() and s.can_edit);
    if not v_can then raise exception 'no_permission'; end if;
    update drawings set name = coalesce(p_name, name), data = p_data, thumb = coalesce(p_thumb, thumb), updated_at = now()
    where id = p_id;
    v_id := p_id;
  end if;
  insert into drawing_versions(drawing_id, data) values (v_id, p_data);
  delete from drawing_versions where drawing_id = v_id and id not in
    (select id from drawing_versions where drawing_id = v_id order by id desc limit 10);
  return v_id;
end; $$;
grant execute on function public.save_drawing(uuid, text, jsonb, text) to authenticated;

-- 내 도면 + 공유받은 도면 목록 (데이터 제외, 목록용)
create or replace function public.list_drawings()
returns table(id uuid, name text, thumb text, updated_at timestamptz, is_mine boolean, can_edit boolean, owner_name text)
language sql security definer set search_path = public as $$
  select d.id, d.name, d.thumb, d.updated_at,
         (d.owner = auth.uid()) as is_mine,
         (d.owner = auth.uid()) or coalesce(s.can_edit,false) as can_edit,
         p.username as owner_name
  from drawings d
  left join drawing_shares s on s.drawing_id = d.id and s.shared_with = auth.uid()
  left join profiles p on p.id = d.owner
  where d.owner = auth.uid() or s.shared_with = auth.uid()
  order by d.updated_at desc;
$$;
grant execute on function public.list_drawings() to authenticated;

-- 공유 추가/삭제 (아이디로)
create or replace function public.share_drawing(p_id uuid, p_username text, p_can_edit boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if not exists(select 1 from drawings where id = p_id and owner = auth.uid()) then raise exception 'no_permission'; end if;
  select id into v_uid from profiles where username = p_username;
  if v_uid is null then raise exception 'user_not_found'; end if;
  if v_uid = auth.uid() then raise exception 'self_share'; end if;
  insert into drawing_shares(drawing_id, shared_with, can_edit) values (p_id, v_uid, p_can_edit)
  on conflict (drawing_id, shared_with) do update set can_edit = p_can_edit;
end; $$;
grant execute on function public.share_drawing(uuid, text, boolean) to authenticated;

create or replace function public.unshare_drawing(p_id uuid, p_username text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from drawing_shares s using profiles p
  where s.drawing_id = p_id and p.username = p_username and s.shared_with = p.id
    and exists(select 1 from drawings d where d.id = p_id and d.owner = auth.uid());
end; $$;
grant execute on function public.unshare_drawing(uuid, text) to authenticated;

create or replace function public.list_shares(p_id uuid)
returns table(username text, can_edit boolean)
language sql security definer set search_path = public as $$
  select p.username, s.can_edit from drawing_shares s join profiles p on p.id = s.shared_with
  where s.drawing_id = p_id and exists(select 1 from drawings d where d.id = p_id and d.owner = auth.uid());
$$;
grant execute on function public.list_shares(uuid) to authenticated;

-- 오류 기록 (비로그인 포함)
create or replace function public.log_error(p_message text, p_source text)
returns void language sql security definer set search_path = public as $$
  insert into error_logs(user_id, message, source, ua)
  values (auth.uid(), left(p_message, 500), left(p_source, 200), left(current_setting('request.headers', true)::json->>'user-agent', 300));
$$;
grant execute on function public.log_error(text, text) to anon, authenticated;

-- 사용 통계 반영 ({"tool:line": 3, ...})
create or replace function public.bump_usage(p_events jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare k text; v int;
begin
  if auth.uid() is null then return; end if;
  for k, v in select key, value::int from jsonb_each_text(p_events) loop
    insert into usage_stats(user_id, day, event, count) values (auth.uid(), current_date, left(k,60), least(v,10000))
    on conflict (user_id, day, event) do update set count = usage_stats.count + excluded.count;
  end loop;
end; $$;
grant execute on function public.bump_usage(jsonb) to authenticated;

-- 피드백
create or replace function public.send_feedback(p_message text)
returns void language sql security definer set search_path = public as $$
  insert into feedback(user_id, username, message, ua)
  select auth.uid(), p.username, left(p_message, 2000), left(current_setting('request.headers', true)::json->>'user-agent', 300)
  from profiles p where p.id = auth.uid();
$$;
grant execute on function public.send_feedback(text) to authenticated;

-- 내 플랜 조회
create or replace function public.my_plan()
returns text language sql security definer set search_path = public as $$
  select coalesce((select plan from profiles where id = auth.uid()), 'free');
$$;
grant execute on function public.my_plan() to authenticated;
