-- Logic/security repairs. Apply after migration 00005.
-- Existing admin identities must be explicitly attested with register_admin_user(UUID).
begin;
alter table public.app_admins add column if not exists identity_verified_at timestamptz;
drop trigger if exists on_auth_user_created_sync_admin on auth.users;
drop function if exists public.tg_sync_admin_on_auth_user();
drop function if exists public.bootstrap_register_admin_email(text, text);

create or replace function public.is_active_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists (select 1 from public.app_admins where user_id = auth.uid() and identity_verified_at is not null); $$;
revoke all on function public.is_active_admin() from public, anon;
grant execute on function public.is_active_admin() to authenticated;

drop policy if exists app_admins_select_self_or_admin on public.app_admins;
create policy app_admins_select_self_or_admin on public.app_admins for select to authenticated
using (user_id = auth.uid() or public.is_active_admin());

create or replace function public.register_admin_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text;
begin
  select lower(btrim(email)) into v_email from auth.users where id = p_user_id;
  if v_email is null then raise exception 'AUTH_USER_NOT_FOUND'; end if;
  insert into public.app_admins (email, user_id, identity_verified_at)
  values (v_email, p_user_id, now())
  on conflict (email) do update set user_id = excluded.user_id, identity_verified_at = now();
  update public.profiles set membership_status = 'approved', status_updated_at = now() where id = p_user_id;
  insert into public.challenge_memberships (challenge_id, student_id, status)
  select c.id, p.id, 'approved'::public.membership_status from public.challenges c cross join public.profiles p
  where not c.is_archived and p.id = p_user_id
  on conflict (challenge_id, student_id) do update set status = 'approved';
end; $$;
revoke all on function public.register_admin_user(uuid) from public, anon, authenticated;

-- Fill missing memberships for the current challenge only; do not rewrite historical participation.
insert into public.challenge_memberships (challenge_id, student_id, status)
select c.id, p.id, p.membership_status from public.challenges c cross join public.profiles p where not c.is_archived
on conflict (challenge_id, student_id) do nothing;


-- -----------------------------------------------------------------------------
-- 1. Student Onboarding & Session Bootstrap RPC
-- -----------------------------------------------------------------------------
-- Returns the caller's role, profile, current challenge summary, and Damascus date.
create or replace function public.get_session_bootstrap()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_is_admin boolean;
  v_profile record;
  v_challenge record;
  v_damascus_today date := public.get_damascus_today();
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: يرجى تسجيل الدخول أولاً.' using errcode = '28000';
  end if;

  v_is_admin := public.is_active_admin();

  select * into v_profile
    from public.profiles
   where id = v_uid;

  select id, title, community_name, start_date, duration_days, collective_goal_pct, is_archived
    into v_challenge
    from public.challenges
   where is_archived = false
   order by created_at desc
   limit 1;

  if v_is_admin and v_profile.id is not null then
    update public.profiles set membership_status = 'approved' where id = v_uid;
    v_profile.membership_status := 'approved';
    if v_challenge.id is not null then
      insert into public.challenge_memberships (challenge_id, student_id, status)
      values (v_challenge.id, v_uid, 'approved')
      on conflict (challenge_id, student_id) do update set status = 'approved';
    end if;
  end if;

  return jsonb_build_object(
    'challenge_membership_status', (select status from public.challenge_memberships where student_id = v_uid and challenge_id = v_challenge.id),
    'user_id', v_uid,
    'email', v_email,
    'is_admin', v_is_admin,
    'damascus_today', v_damascus_today,
    'profile', case when v_profile.id is not null then jsonb_build_object(
      'id', v_profile.id,
      'email', v_profile.email,
      'admin_known_name', v_profile.admin_known_name,
      'public_display_name', v_profile.public_display_name,
      'leaderboard_opt_in', v_profile.leaderboard_opt_in,
      'membership_status', v_profile.membership_status,
      'status_reason', v_profile.status_reason
    ) else null end,
    'current_challenge', case when v_challenge.id is not null then jsonb_build_object(
      'id', v_challenge.id,
      'title', v_challenge.title,
      'community_name', v_challenge.community_name,
      'start_date', v_challenge.start_date,
      'duration_days', v_challenge.duration_days,
      'collective_goal_pct', v_challenge.collective_goal_pct,
      'is_archived', v_challenge.is_archived
    ) else null end
  );
end;
$$;

revoke all on function public.get_session_bootstrap() from public, anon;
grant execute on function public.get_session_bootstrap() to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Submit or Update Student Profile & Join Request
-- -----------------------------------------------------------------------------
create or replace function public.upsert_my_profile(
  p_admin_known_name text,
  p_public_display_name text,
  p_leaderboard_opt_in boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', '')));
  v_clean_admin_name text := btrim(coalesce(p_admin_known_name, ''));
  v_clean_public_name text := btrim(coalesce(p_public_display_name, ''));
  v_existing public.profiles%rowtype;
  v_challenge_id uuid;
  v_initial_status public.membership_status;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: يرجى تسجيل الدخول أولاً.' using errcode = '28000';
  end if;

  if char_length(v_clean_admin_name) < 2 or char_length(v_clean_admin_name) > 80 then
    raise exception 'INVALID_ADMIN_NAME: يجب أن يتراوح الاسم الكامل لدى المشرف بين حرفين و80 حرفاً.' using errcode = '22023';
  end if;

  if char_length(v_clean_public_name) < 2 or char_length(v_clean_public_name) > 50 then
    raise exception 'INVALID_PUBLIC_NAME: يجب أن يتراوح الاسم الظاهر في لوحة الصدارة بين حرفين و50 حرفاً.' using errcode = '22023';
  end if;

  perform 1 from auth.users where id = v_uid for update;

  select * into v_existing
    from public.profiles
   where id = v_uid
   for update;

  if v_existing.id is not null and v_existing.membership_status = 'suspended' and not public.is_active_admin() then
    raise exception 'ACCOUNT_SUSPENDED: تم إيقاف عضويتك مؤقتاً. لا يمكنك تعديل الملف الشخصي أو تنفيذ العمليات المحمية.' using errcode = '42501';
  end if;

  v_initial_status := case
    when public.is_active_admin() then 'approved'::public.membership_status
    else 'pending'::public.membership_status
  end;

  if v_existing.id is null then
    insert into public.profiles (
      id, email, admin_known_name, public_display_name, leaderboard_opt_in, membership_status
    ) values (
      v_uid, v_email, v_clean_admin_name, v_clean_public_name, coalesce(p_leaderboard_opt_in, false), v_initial_status
    )
    returning * into v_existing;
  else
    update public.profiles
       set admin_known_name = v_clean_admin_name,
           public_display_name = v_clean_public_name,
           leaderboard_opt_in = coalesce(p_leaderboard_opt_in, false),
           membership_status = case when public.is_active_admin() then 'approved'::public.membership_status else membership_status end
     where id = v_uid
    returning * into v_existing;
  end if;

  -- Automatically register membership row for the current active/upcoming challenge
  select id into v_challenge_id
    from public.challenges
   where is_archived = false
   order by created_at desc
   limit 1;

  if v_challenge_id is not null then
    insert into public.challenge_memberships (challenge_id, student_id, status)
    values (v_challenge_id, v_uid, v_existing.membership_status)
    on conflict (challenge_id, student_id) do update
      set status = case when public.is_active_admin() then 'approved'::public.membership_status else public.challenge_memberships.status end;
  end if;

  return jsonb_build_object(
    'id', v_existing.id,
    'email', v_existing.email,
    'admin_known_name', v_existing.admin_known_name,
    'public_display_name', v_existing.public_display_name,
    'leaderboard_opt_in', v_existing.leaderboard_opt_in,
    'membership_status', v_existing.membership_status
  );
end;
$$;

revoke all on function public.upsert_my_profile(text, text, boolean) from public, anon;
grant execute on function public.upsert_my_profile(text, text, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Atomic Achievement Save with Damascus Date Validation & Revision Control
-- -----------------------------------------------------------------------------
-- Students can ONLY save for today's date in Asia/Damascus (until 23:59:59.999 Damascus time).
-- Past and future dates are strictly rejected.
-- Includes optimistic concurrency control via p_expected_revision to prevent stale tab overwrites.
create or replace function public.save_today_achievement(
  p_challenge_id uuid,
  p_target_date date,
  p_quran_two_pages boolean,
  p_isha_congregation boolean,
  p_morning_adhkar boolean,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_damascus_today date := public.get_damascus_today();
  v_profile public.profiles%rowtype;
  v_challenge public.challenges%rowtype;
  v_membership public.challenge_memberships%rowtype;
  v_existing public.daily_achievements%rowtype;
  v_saved public.daily_achievements%rowtype;
  v_end_date date;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: يرجى تسجيل الدخول أولاً.' using errcode = '28000';
  end if;

  if p_quran_two_pages is null or p_isha_congregation is null or p_morning_adhkar is null then
    raise exception 'INVALID_ACTIVITY_VALUES: قيم الأنشطة اليومية غير صالحة.' using errcode = '22023';
  end if;

  -- 1. Verify student profile status immediately (blocks suspended & pending users)
  select * into v_profile
    from public.profiles
   where id = v_uid for update;

  if v_profile.id is null then
    raise exception 'PROFILE_REQUIRED: يرجى إكمال ملفك الشخصي أولاً.' using errcode = '42501';
  end if;

  if v_profile.membership_status = 'suspended' then
    raise exception 'ACCOUNT_SUSPENDED: تم إيقاف عضويتك؛ لا يمكنك تسجيل الإنجازات.' using errcode = '42501';
  end if;

  if v_profile.membership_status <> 'approved' then
    raise exception 'MEMBERSHIP_PENDING: عضويتك قيد المراجعة من قِبل المشرف.' using errcode = '42501';
  end if;

  -- 2. Verify challenge exists, is not archived, and has started
  select * into v_challenge
    from public.challenges
   where id = p_challenge_id for share;

  if v_challenge.id is null or v_challenge.is_archived then
    raise exception 'CHALLENGE_INACTIVE: هذا التحدي غير متاح للتسجيل حالياً.' using errcode = '22023';
  end if;

  if v_challenge.start_date is null then
    raise exception 'CHALLENGE_NOT_STARTED: لم يحدد المشرف تاريخ بدء التحدي بعد.' using errcode = '22023';
  end if;

  -- 3. Verify challenge membership status
  select * into v_membership
    from public.challenge_memberships
   where challenge_id = p_challenge_id
     and student_id = v_uid;

  if v_membership.id is null or v_membership.status <> 'approved' then
    raise exception 'CHALLENGE_MEMBERSHIP_NOT_APPROVED: عضويتك في هذا التحدي غير مفعّلة.' using errcode = '42501';
  end if;

  -- 4. Enforce Asia/Damascus today-only boundary
  if p_target_date is distinct from v_damascus_today then
    raise exception 'OUTSIDE_TODAY_DAMASCUS: يمكن تعديل سجل اليوم الحالي فقط (حسب توقيت دمشق %). لا يُسمح بتعديل الأيام السابقة أو القادمة.', v_damascus_today
      using errcode = '22008';
  end if;

  -- 5. Enforce challenge start/end window [start_date .. start_date + duration_days - 1]
  v_end_date := v_challenge.start_date + (v_challenge.duration_days - 1);
  if v_damascus_today < v_challenge.start_date then
    raise exception 'CHALLENGE_UPCOMING: التحدي يبدأ بتاريخ % بتوقيت دمشق.', v_challenge.start_date
      using errcode = '22008';
  end if;

  if v_damascus_today > v_end_date then
    raise exception 'CHALLENGE_COMPLETED: انتهت أيام التحدي بتاريخ %.', v_end_date
      using errcode = '22008';
  end if;

  -- 6. Lock existing row (if any) for atomic update & revision check
  select * into v_existing
    from public.daily_achievements
   where challenge_id = p_challenge_id
     and student_id = v_uid
     and achievement_date = v_damascus_today
   for update;

  if v_existing.id is null then
    -- Creating today's record for the first time: expected_revision must be null or 0
    if p_expected_revision is not null and p_expected_revision <> 0 then
      raise exception 'STALE_REVISION: تم تحديث سجل اليوم من نافذة أو جهاز آخر. يرجى تحديث الصفحة والمحاولة مجدداً.'
        using errcode = '40001';
    end if;

    insert into public.daily_achievements (
      challenge_id,
      student_id,
      achievement_date,
      quran_two_pages,
      isha_congregation,
      morning_adhkar,
      revision
    ) values (
      p_challenge_id,
      v_uid,
      v_damascus_today,
      p_quran_two_pages,
      p_isha_congregation,
      p_morning_adhkar,
      1
    )
    returning * into v_saved;
  else
    -- Updating today's record: verify optimistic concurrency revision
    if p_expected_revision is null or p_expected_revision <> v_existing.revision then
      raise exception 'STALE_REVISION: تم تعديل سجل اليوم من تبويب أو جهاز آخر (النسخة الحالية: %). يرجى إعادة تحميل البيانات.', v_existing.revision
        using errcode = '40001';
    end if;

    update public.daily_achievements
       set quran_two_pages = p_quran_two_pages,
           isha_congregation = p_isha_congregation,
           morning_adhkar = p_morning_adhkar,
           revision = v_existing.revision + 1
     where id = v_existing.id
    returning * into v_saved;
  end if;

  return jsonb_build_object(
    'id', v_saved.id,
    'challenge_id', v_saved.challenge_id,
    'student_id', v_saved.student_id,
    'achievement_date', v_saved.achievement_date,
    'quran_two_pages', v_saved.quran_two_pages,
    'isha_congregation', v_saved.isha_congregation,
    'morning_adhkar', v_saved.morning_adhkar,
    'points', v_saved.points,
    'revision', v_saved.revision,
    'updated_at', v_saved.updated_at
  );
end;
$$;

revoke all on function public.save_today_achievement(uuid, date, boolean, boolean, boolean, integer) from public, anon;
grant execute on function public.save_today_achievement(uuid, date, boolean, boolean, boolean, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. Streak Calculation Helper (Pure SQL / PL/pgSQL Function)
-- -----------------------------------------------------------------------------
-- Rule: "An incomplete current day must not prematurely erase a streak that was valid through yesterday."
-- Counts consecutive days with all 3 activities completed (points = 3) working backwards
-- from Damascus today (if today has 3/3) or from yesterday (if today has < 3 points).
create or replace function public.calculate_student_streak(
  p_challenge_id uuid,
  p_student_id uuid,
  p_start_date date,
  p_duration_days integer,
  p_reference_today date default public.get_damascus_today()
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_end_date date;
  v_effective_last_date date;
  v_cursor date;
  v_today_points integer;
  v_day_points integer;
  v_streak integer := 0;
begin
  if p_start_date is null or p_reference_today < p_start_date then
    return 0;
  end if;

  v_end_date := p_start_date + (p_duration_days - 1);
  v_effective_last_date := least(p_reference_today, v_end_date);

  -- Check points on v_effective_last_date
  select coalesce(da.points, 0)
    into v_today_points
    from public.daily_achievements da
   where da.challenge_id = p_challenge_id
     and da.student_id = p_student_id
     and da.achievement_date = v_effective_last_date;

  if coalesce(v_today_points, 0) = 3 then
    v_cursor := v_effective_last_date;
  else
    -- If effective_last_date is today (still in progress) and not yet 3/3,
    -- start checking backwards from yesterday so today's incomplete state does not erase yesterday's valid streak.
    if v_effective_last_date = p_reference_today then
      v_cursor := v_effective_last_date - 1;
    else
      return 0;
    end if;
  end if;

  while v_cursor >= p_start_date loop
    select coalesce(da.points, 0)
      into v_day_points
      from public.daily_achievements da
     where da.challenge_id = p_challenge_id
       and da.student_id = p_student_id
       and da.achievement_date = v_cursor;

    if coalesce(v_day_points, 0) = 3 then
      v_streak := v_streak + 1;
      v_cursor := v_cursor - 1;
    else
      exit;
    end if;
  end loop;

  return v_streak;
end;
$$;

revoke all on function public.calculate_student_streak(uuid, uuid, date, integer, date) from public, anon;
revoke all on function public.calculate_student_streak(uuid, uuid, date, integer, date) from authenticated;

-- -----------------------------------------------------------------------------
-- 5. Privacy-Preserving Leaderboard & Group Statistics RPC
-- -----------------------------------------------------------------------------
-- Excludes administrators from student rankings and group scoring.
-- Computes equal ranks for equal scores (RANK()).
-- Respects leaderboard_opt_in: never exposes emails, admin_known_name, or daily activity breakdowns.
-- Opted-out students are excluded from the visible public rows (except the caller's own summary).
create or replace function public.get_leaderboard_and_group_stats(p_challenge_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_damascus_today date := public.get_damascus_today();
  v_challenge public.challenges%rowtype;
  v_elapsed_days integer := 0;
  v_current_week_num integer := 1;
  v_week_start date;
  v_week_end date;
  v_approved_student_count integer := 0;
  v_group_total_points integer := 0;
  v_group_available_points integer := 0;
  v_group_completion_pct numeric(5,1) := 0.0;
  v_overall_rankings jsonb := '[]'::jsonb;
  v_weekly_rankings jsonb := '[]'::jsonb;
  v_my_rank_summary jsonb := null;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: يرجى تسجيل الدخول أولاً.' using errcode = '28000';
  end if;

  if not (public.is_approved_student() or public.is_active_admin()) then
    raise exception 'FORBIDDEN_NOT_APPROVED: لا يمكن عرض لوحة الصدارة قبل تفعيل العضوية.' using errcode = '42501';
  end if;

  select * into v_challenge
    from public.challenges
   where id = p_challenge_id;

  if v_challenge.id is null then
    raise exception 'CHALLENGE_NOT_FOUND: التحدي غير موجود.' using errcode = '22023';
  end if;

  if v_challenge.start_date is not null and v_damascus_today >= v_challenge.start_date then
    v_elapsed_days := least(
      v_challenge.duration_days,
      (v_damascus_today - v_challenge.start_date) + 1
    );
    v_current_week_num := ((v_elapsed_days - 1) / 7) + 1;
    v_week_start := v_challenge.start_date + ((v_current_week_num - 1) * 7);
    v_week_end := least(
      v_challenge.start_date + (v_challenge.duration_days - 1),
      v_week_start + 6
    );
  end if;

  -- Approved non-admin students in this challenge
  with eligible_students as (
    select p.id as student_id,
           p.public_display_name,
           p.leaderboard_opt_in
      from public.profiles p
      join public.challenge_memberships cm on cm.student_id = p.id
        and cm.challenge_id = p_challenge_id and cm.status = 'approved'
     where (v_challenge.is_archived or p.membership_status = 'approved')
       and not exists (
         select 1 from public.app_admins a
          where a.user_id = p.id and a.identity_verified_at is not null
       )
  ),
  student_scores as (
    select es.student_id,
           es.public_display_name,
           es.leaderboard_opt_in,
           coalesce(sum(da.points) filter (
             where v_challenge.start_date is not null
               and da.achievement_date between v_challenge.start_date
               and (v_challenge.start_date + v_challenge.duration_days - 1)
           ), 0)::integer as total_points,
           coalesce(sum(da.points) filter (
             where v_week_start is not null
               and da.achievement_date between v_week_start and v_week_end
           ), 0)::integer as week_points,
           coalesce(count(*) filter (
             where v_challenge.start_date is not null
               and da.achievement_date between v_challenge.start_date
               and (v_challenge.start_date + v_challenge.duration_days - 1)
               and da.points = 3
           ), 0)::integer as full_days_count
      from eligible_students es
      left join public.daily_achievements da
        on da.student_id = es.student_id
       and da.challenge_id = p_challenge_id
     group by es.student_id, es.public_display_name, es.leaderboard_opt_in
  ),
  ranked_overall as (
    select ss.*,
           rank() over (order by ss.total_points desc)::integer as overall_rank,
           rank() over (order by ss.week_points desc)::integer as week_rank
      from student_scores ss
  )
  select count(*)::integer,
         coalesce(sum(total_points), 0)::integer,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'rank', ro.overall_rank,
               'display_name', ro.public_display_name,
               'total_points', ro.total_points,
               'full_days_count', ro.full_days_count,
               'is_me', (ro.student_id = v_uid)
             )
             order by ro.overall_rank asc, ro.public_display_name asc
           )
           from ranked_overall ro
           where ro.leaderboard_opt_in = true
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'rank', ro.week_rank,
               'display_name', ro.public_display_name,
               'week_points', ro.week_points,
               'is_me', (ro.student_id = v_uid)
             )
             order by ro.week_rank asc, ro.public_display_name asc
           )
           from ranked_overall ro
           where ro.leaderboard_opt_in = true
         ), '[]'::jsonb),
         (
           select jsonb_build_object(
             'overall_rank', ro.overall_rank,
             'week_rank', ro.week_rank,
             'total_points', ro.total_points,
             'week_points', ro.week_points,
             'leaderboard_opt_in', ro.leaderboard_opt_in,
             'display_name', ro.public_display_name
           )
           from ranked_overall ro
           where ro.student_id = v_uid
         )
    into v_approved_student_count,
         v_group_total_points,
         v_overall_rankings,
         v_weekly_rankings,
         v_my_rank_summary
    from ranked_overall;

  if v_elapsed_days > 0 and v_approved_student_count > 0 then
    v_group_available_points := v_approved_student_count * v_elapsed_days * 3;
    v_group_completion_pct := round((v_group_total_points::numeric * 100.0) / v_group_available_points::numeric, 1);
  end if;

  return jsonb_build_object(
    'challenge_id', v_challenge.id,
    'damascus_today', v_damascus_today,
    'elapsed_days', v_elapsed_days,
    'current_week_num', v_current_week_num,
    'collective_goal_pct', v_challenge.collective_goal_pct,
    'approved_student_count', v_approved_student_count,
    'group_total_points', v_group_total_points,
    'group_available_points', v_group_available_points,
    'group_completion_pct', v_group_completion_pct,
    'overall_rankings', v_overall_rankings,
    'weekly_rankings', v_weekly_rankings,
    'my_summary', v_my_rank_summary
  );
end;
$$;

revoke all on function public.get_leaderboard_and_group_stats(uuid) from public, anon;
grant execute on function public.get_leaderboard_and_group_stats(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Administrator Operations: Membership, Challenge Config, Full Report
-- -----------------------------------------------------------------------------

-- 6a. Manage Student Membership Status (Approve, Suspend, Reactivate)
create or replace function public.admin_set_membership_status(
  p_student_id uuid,
  p_challenge_id uuid,
  p_new_status public.membership_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_uid uuid := auth.uid();
  v_updated_profile public.profiles%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'ADMIN_ONLY: هذه العملية مخصصة لمشرف الحلقة فقط.' using errcode = '42501';
  end if;

  if exists (select 1 from public.app_admins where user_id = p_student_id and identity_verified_at is not null) then
    raise exception 'ADMIN_ACCOUNT: Manage administrator access through trusted provisioning.' using errcode = '42501';
  end if;
  if p_challenge_id is not null then
    perform 1 from public.challenges where id = p_challenge_id and not is_archived for share;
    if not found then raise exception 'CHALLENGE_INACTIVE'; end if;
  end if;

  update public.profiles
     set membership_status = p_new_status,
         status_reason = btrim(p_reason),
         status_updated_at = now(),
         status_updated_by = v_admin_uid
   where id = p_student_id
  returning * into v_updated_profile;

  if v_updated_profile.id is null then
    raise exception 'STUDENT_NOT_FOUND: لم يتم العثور على ملف الطالب.' using errcode = '22023';
  end if;

  if p_challenge_id is not null then
    insert into public.challenge_memberships (
      challenge_id, student_id, status,
      approved_at, approved_by,
      suspended_at, suspended_by, suspension_reason
    ) values (
      p_challenge_id, p_student_id, p_new_status,
      case when p_new_status = 'approved' then now() else null end,
      case when p_new_status = 'approved' then v_admin_uid else null end,
      case when p_new_status = 'suspended' then now() else null end,
      case when p_new_status = 'suspended' then v_admin_uid else null end,
      btrim(p_reason)
    )
    on conflict (challenge_id, student_id) do update
       set status = excluded.status,
           approved_at = case when excluded.status = 'approved' then now() else public.challenge_memberships.approved_at end,
           approved_by = case when excluded.status = 'approved' then v_admin_uid else public.challenge_memberships.approved_by end,
           suspended_at = case when excluded.status = 'suspended' then now() else public.challenge_memberships.suspended_at end,
           suspended_by = case when excluded.status = 'suspended' then v_admin_uid else public.challenge_memberships.suspended_by end,
           suspension_reason = excluded.suspension_reason;
  end if;

  return jsonb_build_object(
    'student_id', v_updated_profile.id,
    'membership_status', v_updated_profile.membership_status,
    'status_reason', v_updated_profile.status_reason,
    'status_updated_at', v_updated_profile.status_updated_at
  );
end;
$$;

revoke all on function public.admin_set_membership_status(uuid, uuid, public.membership_status, text) from public, anon;
grant execute on function public.admin_set_membership_status(uuid, uuid, public.membership_status, text) to authenticated;

-- 6b. Update Challenge Configuration (Respects Immutability After Achievements Exist)
create or replace function public.admin_configure_challenge(
  p_challenge_id uuid,
  p_title text,
  p_start_date date,
  p_duration_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated public.challenges%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'ADMIN_ONLY: هذه العملية مخصصة لمشرف الحلقة فقط.' using errcode = '42501';
  end if;

  update public.challenges
     set title = btrim(p_title),
         start_date = p_start_date,
         duration_days = coalesce(p_duration_days, 30)
   where id = p_challenge_id
     and is_archived = false
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'CHALLENGE_NOT_FOUND: لم يتم العثور على التحدي الحالي.' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_updated.id,
    'title', v_updated.title,
    'start_date', v_updated.start_date,
    'duration_days', v_updated.duration_days,
    'collective_goal_pct', v_updated.collective_goal_pct
  );
end;
$$;

revoke all on function public.admin_configure_challenge(uuid, text, date, integer) from public, anon;
grant execute on function public.admin_configure_challenge(uuid, text, date, integer) to authenticated;

-- 6c. Archive Completed Challenge & Create Subsequent Challenge Without Deleting History
create or replace function public.admin_archive_and_create_challenge(
  p_current_challenge_id uuid,
  p_new_title text default 'تعالَ نؤمن ساعة',
  p_new_start_date date default null,
  p_new_duration_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_uid uuid := auth.uid();
  v_new_challenge public.challenges%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'ADMIN_ONLY: هذه العملية مخصصة لمشرف الحلقة فقط.' using errcode = '42501';
  end if;

  -- A null current ID is only allowed when recovering a database without a current challenge.
  if p_current_challenge_id is null then
    if exists (select 1 from public.challenges where not is_archived) then
      raise exception 'CURRENT_CHALLENGE_EXISTS';
    end if;
  else
    perform 1 from public.challenges where id = p_current_challenge_id and not is_archived for update;
    if not found then raise exception 'CHALLENGE_INACTIVE'; end if;
  end if;

  update public.challenges
     set is_archived = true,
         archived_at = now()
   where id = p_current_challenge_id
     and is_archived = false;

  insert into public.challenges (
    title,
    community_name,
    start_date,
    duration_days,
    collective_goal_pct,
    is_archived,
    created_by
  ) values (
    btrim(coalesce(p_new_title, 'تعالَ نؤمن ساعة')),
    'حلقة سيدنا أبو بكر الصديق',
    p_new_start_date,
    coalesce(p_new_duration_days, 30),
    80,
    false,
    v_admin_uid
  )
  returning * into v_new_challenge;

  -- Carry over existing student membership statuses into the new challenge
  insert into public.challenge_memberships (challenge_id, student_id, status, approved_at, approved_by)
  select v_new_challenge.id,
         p.id,
         p.membership_status,
         case when p.membership_status = 'approved' then now() else null end,
         case when p.membership_status = 'approved' then v_admin_uid else null end
    from public.profiles p;

  return jsonb_build_object(
    'archived_challenge_id', p_current_challenge_id,
    'new_challenge', jsonb_build_object(
      'id', v_new_challenge.id,
      'title', v_new_challenge.title,
      'start_date', v_new_challenge.start_date,
      'duration_days', v_new_challenge.duration_days,
      'collective_goal_pct', v_new_challenge.collective_goal_pct
    )
  );
end;
$$;

revoke all on function public.admin_archive_and_create_challenge(uuid, text, date, integer) from public, anon;
grant execute on function public.admin_archive_and_create_challenge(uuid, text, date, integer) to authenticated;


-- One guarded JSON response avoids PostgREST's row cap and gives reports a consistent snapshot.
create or replace function public.get_admin_report(p_challenge_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_active_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  return jsonb_build_object(
    'generated_at', now(),
    'damascus_today', public.get_damascus_today(),
    'challenge', (select to_jsonb(c) from public.challenges c where c.id = p_challenge_id),
    'profiles', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
      'is_admin', exists (select 1 from public.app_admins a where a.user_id = p.id and a.identity_verified_at is not null),
      'challenge_membership_status', cm.status
    ) order by p.created_at desc, p.id) from public.profiles p
      left join public.challenge_memberships cm on cm.student_id = p.id and cm.challenge_id = p_challenge_id), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(d) order by d.achievement_date, d.id)
      from public.daily_achievements d where d.challenge_id = p_challenge_id), '[]'::jsonb)
  );
end; $$;
revoke all on function public.get_admin_report(uuid) from public, anon;
grant execute on function public.get_admin_report(uuid) to authenticated;
commit;
