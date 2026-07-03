-- ============================================================
--  수정 패치 1: 도면 삭제 시 "infinite recursion in policy" 해결
--  (drawings ↔ drawing_shares 정책이 서로를 참조하던 순환을
--   RLS 우회(security definer) 헬퍼 함수로 분리)
--  SQL Editor에 붙여넣고 Run 하세요.
-- ============================================================

-- 헬퍼: 정책 안에서 상호 참조 시 RLS를 우회해 순환을 끊음
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

-- 정책 재작성 (순환 제거)
drop policy if exists "drawings shared read" on public.drawings;
create policy "drawings shared read" on public.drawings for select
  using (public.is_shared_with_me(id));
drop policy if exists "drawings shared edit" on public.drawings;
create policy "drawings shared edit" on public.drawings for update
  using (public.can_edit_shared(id));

drop policy if exists "versions owner" on public.drawing_versions;
create policy "versions owner" on public.drawing_versions
  using (public.is_drawing_owner(drawing_id))
  with check (public.is_drawing_owner(drawing_id));

drop policy if exists "shares owner manage" on public.drawing_shares;
create policy "shares owner manage" on public.drawing_shares
  using (public.is_drawing_owner(drawing_id))
  with check (public.is_drawing_owner(drawing_id));
