-- ============================================================
--  WebCAD 로그인용 Supabase 설정
--  Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 하세요.
-- ============================================================

-- 1) 프로필 테이블 (아이디 저장)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

-- 본인 프로필만 읽기/수정
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update using (auth.uid() = id);

-- 2) 회원가입 시 프로필 자동 생성 (user_metadata.username 사용)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) 아이디 → 이메일 (아이디로 로그인 지원)
create or replace function public.username_to_email(u text)
returns text language sql security definer set search_path = public as $$
  select au.email from public.profiles p join auth.users au on au.id = p.id
  where p.username = u limit 1;
$$;
grant execute on function public.username_to_email(text) to anon, authenticated;

-- 4) 아이디 중복 확인
create or replace function public.username_exists(u text)
returns boolean language sql security definer set search_path = public as $$
  select exists(select 1 from public.profiles where username = u);
$$;
grant execute on function public.username_exists(text) to anon, authenticated;
