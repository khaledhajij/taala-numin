-- =============================================================================
-- Migration: 20261014000002_rls_and_grants.sql
-- Application: «تعالَ نؤمن ساعة» — حلقة سيدنا أبو بكر الصديق
-- Description: Row Level Security (RLS), column-level privileges, restrictive
--              table grants, and immediate suspension enforcement.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Security Helper Functions (SECURITY DEFINER with safe search_path)
-- -----------------------------------------------------------------------------

-- Checks whether the currently authenticated user is a registered administrator.
-- Matches either linked user_id or verified JWT email against public.app_admins.
create or replace function public.is_active_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
begin
  if v_uid is null then
    return false;
  end if;

  return exists (
    select 1
      from public.app_admins a
     where a.user_id = v_uid
        or (v_email <> '' and a.email = v_email)
  );
end;
$$;

revoke all on function public.is_active_admin() from public;
grant execute on function public.is_active_admin() to authenticated;

-- Checks whether the currently authenticated user is an approved, non-suspended student.
-- Reads live database state on every query so suspension takes effect immediately
-- even if the browser still holds an unexpired JWT session.
create or replace function public.is_approved_student()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = auth.uid()
       and p.membership_status = 'approved'
  );
$$;

revoke all on function public.is_approved_student() from public;
grant execute on function public.is_approved_student() to authenticated;

-- Checks whether the caller is approved for a specific challenge
create or replace function public.is_approved_for_challenge(p_challenge_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.profiles p
      join public.challenge_memberships cm
        on cm.student_id = p.id
       and cm.challenge_id = p_challenge_id
     where p.id = auth.uid()
       and p.membership_status = 'approved'
       and cm.status = 'approved'
  );
$$;

revoke all on function public.is_approved_for_challenge(uuid) from public;
grant execute on function public.is_approved_for_challenge(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Enable & Force Row Level Security on All Exposed Tables
-- -----------------------------------------------------------------------------
alter table public.app_admins enable row level security;
alter table public.app_admins force row level security;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

alter table public.challenges enable row level security;
alter table public.challenges force row level security;

alter table public.challenge_memberships enable row level security;
alter table public.challenge_memberships force row level security;

alter table public.daily_achievements enable row level security;
alter table public.daily_achievements force row level security;

-- -----------------------------------------------------------------------------
-- 3. Restrictive Table & Column Grants (Defense in Depth)
-- -----------------------------------------------------------------------------
-- Revoke all default public/anon access across all application tables
revoke all on public.app_admins from public, anon, authenticated;
revoke all on public.profiles from public, anon, authenticated;
revoke all on public.challenges from public, anon, authenticated;
revoke all on public.challenge_memberships from public, anon, authenticated;
revoke all on public.daily_achievements from public, anon, authenticated;

-- app_admins: Authenticated users may only check their own admin row; never insert/update/delete
grant select (id, email, user_id, created_at) on public.app_admins to authenticated;

-- profiles:
-- Authenticated users can read their own profile (or all profiles if admin via RLS).
-- Students may ONLY insert/update their own safe profile fields (admin_known_name,
-- public_display_name, leaderboard_opt_in), NEVER membership_status or status_updated_by.
grant select on public.profiles to authenticated;
grant insert (id, email, admin_known_name, public_display_name, leaderboard_opt_in)
  on public.profiles to authenticated;
grant update (admin_known_name, public_display_name, leaderboard_opt_in)
  on public.profiles to authenticated;

-- challenges:
-- Read access for authenticated users (subject to RLS); mutations happen through admin RPCs or admin RLS
grant select on public.challenges to authenticated;
grant insert, update on public.challenges to authenticated;

-- challenge_memberships:
-- Read access for authenticated users (own row or admin); student can submit initial pending join request
grant select on public.challenge_memberships to authenticated;
grant insert (challenge_id, student_id) on public.challenge_memberships to authenticated;

-- daily_achievements:
-- Read access for own achievements (or admin). All writes go through the atomic
-- save_today_achievement() RPC to enforce Damascus midnight, revision checks, and membership status.
grant select on public.daily_achievements to authenticated;

-- -----------------------------------------------------------------------------
-- 4. RLS Policies
-- -----------------------------------------------------------------------------

-- 4a. app_admins policies
drop policy if exists app_admins_select_self_or_admin on public.app_admins;
create policy app_admins_select_self_or_admin
  on public.app_admins
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or email = lower(btrim(coalesce(auth.jwt() ->> 'email', '')))
    or public.is_active_admin()
  );

-- 4b. profiles policies
-- Students can ONLY read their own profile row. Administrators can read all profiles.
drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin
  on public.profiles
  for select
  to authenticated
  using (
    id = auth.uid()
    or public.is_active_admin()
  );

-- New authenticated user can create their own profile (forced to 'pending' status unless admin)
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (
    id = auth.uid()
    and email = lower(btrim(coalesce(auth.jwt() ->> 'email', email)))
    and membership_status = 'pending'
    and leaderboard_opt_in = coalesce(leaderboard_opt_in, false)
  );

-- Pending and approved students can edit their own display/admin names and leaderboard opt-in.
-- Suspended students are immediately blocked from mutating their profile.
drop policy if exists profiles_update_self_not_suspended on public.profiles;
create policy profiles_update_self_not_suspended
  on public.profiles
  for update
  to authenticated
  using (
    (id = auth.uid() and membership_status in ('pending', 'approved'))
    or public.is_active_admin()
  )
  with check (
    (id = auth.uid() and membership_status in ('pending', 'approved'))
    or public.is_active_admin()
  );

-- 4c. challenges policies
-- Approved students and admins can read challenges; pending/suspended users only see basic current challenge metadata via RPC
drop policy if exists challenges_select_approved_or_admin on public.challenges;
create policy challenges_select_approved_or_admin
  on public.challenges
  for select
  to authenticated
  using (
    public.is_approved_student()
    or public.is_active_admin()
  );

drop policy if exists challenges_admin_insert on public.challenges;
create policy challenges_admin_insert
  on public.challenges
  for insert
  to authenticated
  with check (public.is_active_admin());

drop policy if exists challenges_admin_update on public.challenges;
create policy challenges_admin_update
  on public.challenges
  for update
  to authenticated
  using (public.is_active_admin())
  with check (public.is_active_admin());

-- 4d. challenge_memberships policies
drop policy if exists memberships_select_own_or_admin on public.challenge_memberships;
create policy memberships_select_own_or_admin
  on public.challenge_memberships
  for select
  to authenticated
  using (
    student_id = auth.uid()
    or public.is_active_admin()
  );

drop policy if exists memberships_insert_self_pending on public.challenge_memberships;
create policy memberships_insert_self_pending
  on public.challenge_memberships
  for insert
  to authenticated
  with check (
    student_id = auth.uid()
    and status = 'pending'
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.membership_status <> 'suspended'
    )
  );

-- 4e. daily_achievements policies
-- Approved students can ONLY read their own achievements; suspended & pending students cannot read achievement data.
-- Admins can read all achievements for reporting & CSV export.
drop policy if exists achievements_select_own_approved_or_admin on public.daily_achievements;
create policy achievements_select_own_approved_or_admin
  on public.daily_achievements
  for select
  to authenticated
  using (
    (student_id = auth.uid() and public.is_approved_student())
    or public.is_active_admin()
  );

commit;
