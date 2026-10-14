-- =============================================================================
-- Migration: 20261014000001_initial_schema.sql
-- Application: «تعالَ نؤمن ساعة» — حلقة سيدنا أبو بكر الصديق
-- Description: Core tables, enums, constraints, Damascus timezone helpers,
--              and audit/revision triggers.
-- =============================================================================

begin;

-- Enable pgcrypto for UUID generation if not already enabled
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type public.membership_status as enum ('pending', 'approved', 'suspended');
  end if;

  if not exists (select 1 from pg_type where typname = 'challenge_status') then
    create type public.challenge_status as enum ('upcoming', 'active', 'completed', 'archived');
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- 2. Timezone Helper: Current Date & Timestamp in Asia/Damascus
-- -----------------------------------------------------------------------------
create or replace function public.get_damascus_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Damascus')::date;
$$;

create or replace function public.get_damascus_now()
returns timestamp without time zone
language sql
stable
set search_path = public, pg_temp
as $$
  select (now() at time zone 'Asia/Damascus');
$$;

-- -----------------------------------------------------------------------------
-- 3. Trusted Administrator Registry (app_admins)
-- -----------------------------------------------------------------------------
-- Populated exclusively via trusted database operations / service-role scripts.
-- Never writable by client sessions.
create table if not exists public.app_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and length(email) >= 5),
  user_id uuid unique references auth.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

comment on table public.app_admins is
  'Trusted administrator whitelist keyed by verified Google email and linked auth.users UUID.';

-- -----------------------------------------------------------------------------
-- 4. Profiles Table (profiles)
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  admin_known_name text not null check (char_length(btrim(admin_known_name)) between 2 and 80),
  public_display_name text not null check (char_length(btrim(public_display_name)) between 2 and 50),
  leaderboard_opt_in boolean not null default false,
  membership_status public.membership_status not null default 'pending',
  status_reason text,
  status_updated_at timestamptz not null default now(),
  status_updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Student and administrator profiles. Leaderboard visibility is off (false) by default.';

create index if not exists idx_profiles_membership_status
  on public.profiles(membership_status);

-- -----------------------------------------------------------------------------
-- 5. Challenges Table (challenges)
-- -----------------------------------------------------------------------------
-- Note: Default duration is 30 days. Does not start automatically; admin sets start_date.
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  community_name text not null default 'حلقة سيدنا أبو بكر الصديق',
  start_date date, -- Nullable until administrator explicitly chooses start date
  duration_days integer not null default 30 check (duration_days between 7 and 90),
  collective_goal_pct integer not null default 80 check (collective_goal_pct between 1 and 100),
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.challenges is
  '30-day voluntary challenges. Only one non-archived challenge may be active/upcoming at a time.';

-- Ensure at most one non-archived challenge is current
create unique index if not exists idx_challenges_single_current
  on public.challenges ((not is_archived))
  where is_archived = false;

-- -----------------------------------------------------------------------------
-- 6. Challenge Memberships Table (challenge_memberships)
-- -----------------------------------------------------------------------------
create table if not exists public.challenge_memberships (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  status public.membership_status not null default 'pending',
  joined_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  suspended_at timestamptz,
  suspended_by uuid references auth.users(id) on delete set null,
  suspension_reason text,
  updated_at timestamptz not null default now(),
  constraint uq_challenge_membership unique (challenge_id, student_id)
);

create index if not exists idx_challenge_memberships_challenge_status
  on public.challenge_memberships(challenge_id, status);

create index if not exists idx_challenge_memberships_student
  on public.challenge_memberships(student_id);

-- -----------------------------------------------------------------------------
-- 7. Daily Achievements Table (daily_achievements)
-- -----------------------------------------------------------------------------
-- Stores the 3 specified activities. Points are derived via generated column
-- so browser-submitted scores are never trusted.
create table if not exists public.daily_achievements (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete cascade,
  achievement_date date not null,
  quran_two_pages boolean not null default false,
  isha_congregation boolean not null default false,
  morning_adhkar boolean not null default false,
  points smallint generated always as (
    (case when quran_two_pages then 1 else 0 end) +
    (case when isha_congregation then 1 else 0 end) +
    (case when morning_adhkar then 1 else 0 end)
  ) stored,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_daily_achievement_challenge_student_date
    unique (challenge_id, student_id, achievement_date)
);

comment on table public.daily_achievements is
  'Daily student activity log. Points (0..3) are strictly computed by PostgreSQL generated column.';

create index if not exists idx_daily_achievements_challenge_date
  on public.daily_achievements(challenge_id, achievement_date);

create index if not exists idx_daily_achievements_student_challenge
  on public.daily_achievements(student_id, challenge_id, achievement_date);

-- -----------------------------------------------------------------------------
-- 8. Triggers for Immutability, Timestamps, and Auth Sync
-- -----------------------------------------------------------------------------

-- 8a. Maintain updated_at automatically
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

drop trigger if exists set_challenges_updated_at on public.challenges;
create trigger set_challenges_updated_at
  before update on public.challenges
  for each row execute function public.tg_set_updated_at();

drop trigger if exists set_challenge_memberships_updated_at on public.challenge_memberships;
create trigger set_challenge_memberships_updated_at
  before update on public.challenge_memberships
  for each row execute function public.tg_set_updated_at();

drop trigger if exists set_daily_achievements_updated_at on public.daily_achievements;
create trigger set_daily_achievements_updated_at
  before update on public.daily_achievements
  for each row execute function public.tg_set_updated_at();

-- 8b. Prevent modifying challenge start_date or duration_days once achievements exist
create or replace function public.tg_lock_challenge_dates_after_achievements()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_has_achievements boolean;
begin
  if (old.start_date is distinct from new.start_date)
     or (old.duration_days is distinct from new.duration_days)
     or (old.collective_goal_pct is distinct from new.collective_goal_pct) then
    select exists (
      select 1 from public.daily_achievements where challenge_id = old.id
    ) into v_has_achievements;

    if v_has_achievements then
      raise exception 'CHALLENGE_LOCKED_AFTER_ACHIEVEMENTS: لا يمكن تعديل تاريخ البدء أو مدة التحدي أو قواعد النقاط بعد بدء تسجيل الإنجازات.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists lock_challenge_dates_on_update on public.challenges;
create trigger lock_challenge_dates_on_update
  before update on public.challenges
  for each row execute function public.tg_lock_challenge_dates_after_achievements();

-- 8c. Automatically link app_admins.user_id on Google sign-in if email matches
create or replace function public.tg_sync_admin_on_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is not null then
    update public.app_admins
       set user_id = new.id
     where email = lower(btrim(new.email))
       and (user_id is null or user_id = new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_sync_admin on auth.users;
create trigger on_auth_user_created_sync_admin
  after insert or update of email on auth.users
  for each row execute function public.tg_sync_admin_on_auth_user();

commit;
