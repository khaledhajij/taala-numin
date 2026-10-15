-- =============================================================================
-- Migration: 20261015000007_all_users_in_leaderboard.sql
-- Application: «تعالَ نؤمن ساعة» — حلقة سيدنا أبو بكر الصديق
-- Description: Include all approved students on the leaderboard unconditionally;
--              remove optional choosing / opt-in requirement.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Schema & Data Updates: default leaderboard_opt_in to true for all users
-- -----------------------------------------------------------------------------
alter table public.profiles alter column leaderboard_opt_in set default true;
update public.profiles set leaderboard_opt_in = true where leaderboard_opt_in = false;

-- -----------------------------------------------------------------------------
-- 2. Update Signup Trigger: New users are always opted in
-- -----------------------------------------------------------------------------
create or replace function public.create_signup_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean_email text := lower(btrim(coalesce(new.email, '')));
  v_admin_name text := btrim(coalesce(new.raw_user_meta_data ->> 'admin_known_name', ''));
  v_public_name text := btrim(coalesce(new.raw_user_meta_data ->> 'public_display_name', ''));
  v_is_trusted_admin boolean := false;
  v_initial_status public.membership_status := 'pending';
begin
  if v_clean_email = '' or char_length(v_admin_name) not between 2 and 80
     or char_length(v_public_name) not between 2 and 50 then
    return new;
  end if;

  -- Check if user is in trusted app_admins whitelist
  select exists (
    select 1 from public.app_admins a
     where a.email = v_clean_email
  ) into v_is_trusted_admin;

  if v_is_trusted_admin then
    v_initial_status := 'approved';
    update public.app_admins
       set user_id = new.id
     where email = v_clean_email
       and (user_id is null or user_id = new.id);
  end if;

  insert into public.profiles (
    id,
    email,
    admin_known_name,
    public_display_name,
    leaderboard_opt_in,
    membership_status
  ) values (
    new.id,
    v_clean_email,
    v_admin_name,
    v_public_name,
    true,
    v_initial_status
  )
  on conflict (id) do update
     set admin_known_name = excluded.admin_known_name,
         public_display_name = excluded.public_display_name,
         leaderboard_opt_in = true,
         membership_status = case
           when v_is_trusted_admin then 'approved'::public.membership_status
           else public.profiles.membership_status
         end;

  -- Associate membership with current active/upcoming challenge
  insert into public.challenge_memberships (challenge_id, student_id, status)
  select c.id, new.id, v_initial_status
    from public.challenges c
   where c.is_archived = false
   order by c.created_at desc
   limit 1
  on conflict (challenge_id, student_id) do update
     set status = case
       when v_is_trusted_admin then 'approved'::public.membership_status
       else public.challenge_memberships.status
     end;

  return new;
end;
$$;

revoke all on function public.create_signup_profile() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Update upsert_my_profile: Sets leaderboard_opt_in to true unconditionally
-- -----------------------------------------------------------------------------
create or replace function public.upsert_my_profile(
  p_admin_known_name text,
  p_public_display_name text,
  p_leaderboard_opt_in boolean default true
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
      v_uid, v_email, v_clean_admin_name, v_clean_public_name, true, v_initial_status
    )
    returning * into v_existing;
  else
    update public.profiles
       set admin_known_name = v_clean_admin_name,
           public_display_name = v_clean_public_name,
           leaderboard_opt_in = true,
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
-- 4. Leaderboard & Group Statistics RPC: Include all approved students
-- -----------------------------------------------------------------------------
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
    'my_rank_summary', v_my_rank_summary
  );
end;
$$;

revoke all on function public.get_leaderboard_and_group_stats(uuid) from public, anon;
grant execute on function public.get_leaderboard_and_group_stats(uuid) to authenticated;

commit;

