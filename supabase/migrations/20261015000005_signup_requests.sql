-- =============================================================================
-- Migration: 20261015000005_signup_requests.sql
-- Application: «تعالَ نؤمن ساعة» — حلقة سيدنا أبو بكر الصديق
-- Description: Persist signup requests immediately upon auth.users insertion,
--              link trusted admin users automatically to 'approved', and harden
--              admin challenge configuration to allow creating the initial
--              challenge if none exists.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Automatic Signup Profile Trigger
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
  v_opt_in boolean := false;
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

  v_opt_in := coalesce(
    case
      when new.raw_user_meta_data ->> 'leaderboard_opt_in' in ('true', 't', '1') then true
      else false
    end,
    false
  );

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
    v_opt_in,
    v_initial_status
  )
  on conflict (id) do update
     set admin_known_name = excluded.admin_known_name,
         public_display_name = excluded.public_display_name,
         leaderboard_opt_in = excluded.leaderboard_opt_in,
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

drop trigger if exists on_auth_user_signup_profile on auth.users;
create trigger on_auth_user_signup_profile
  after insert on auth.users
  for each row execute function public.create_signup_profile();

-- -----------------------------------------------------------------------------
-- 2. Hardened admin_configure_challenge (Handles Initial Setup / Upsert)
-- -----------------------------------------------------------------------------
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
  v_admin_uid uuid := auth.uid();
  v_updated public.challenges%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'ADMIN_ONLY: هذه العملية مخصصة لمشرف الحلقة فقط.' using errcode = '42501';
  end if;

  if p_challenge_id is not null then
    update public.challenges
       set title = btrim(p_title),
           start_date = p_start_date,
           duration_days = coalesce(p_duration_days, 30)
     where id = p_challenge_id
       and is_archived = false
    returning * into v_updated;
  end if;

  -- If not found by ID, attempt to update the latest non-archived challenge
  if v_updated.id is null then
    update public.challenges
       set title = btrim(p_title),
           start_date = p_start_date,
           duration_days = coalesce(p_duration_days, 30)
     where id = (
       select id from public.challenges
        where is_archived = false
        order by created_at desc
        limit 1
     )
    returning * into v_updated;
  end if;

  -- If no challenge exists at all, insert the initial challenge
  if v_updated.id is null then
    insert into public.challenges (
      title,
      community_name,
      start_date,
      duration_days,
      collective_goal_pct,
      is_archived,
      created_by
    ) values (
      btrim(coalesce(p_title, 'تعالَ نؤمن ساعة')),
      'حلقة سيدنا أبو بكر الصديق',
      p_start_date,
      coalesce(p_duration_days, 30),
      80,
      false,
      v_admin_uid
    )
    returning * into v_updated;
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

commit;
