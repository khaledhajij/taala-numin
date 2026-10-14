-- =============================================================================
-- Migration: 20261014000004_bootstrap_admin.sql
-- Application: «تعالَ نؤمن ساعة» — حلقة سيدنا أبو بكر الصديق
-- Description: Trusted administrator bootstrap for hajij94@gmail.com and
--              initial challenge creation.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Bootstrap Initial Challenge (Does NOT start automatically; start_date = NULL)
-- -----------------------------------------------------------------------------
insert into public.challenges (
  title,
  community_name,
  start_date,
  duration_days,
  collective_goal_pct,
  is_archived
)
select
  'تعالَ نؤمن ساعة',
  'حلقة سيدنا أبو بكر الصديق',
  null, -- Administrator chooses start_date explicitly from the Admin Dashboard
  30,
  80,
  false
where not exists (
  select 1 from public.challenges where is_archived = false
);

-- -----------------------------------------------------------------------------
-- 2. Trusted Administrator Helper Function (Service Role / SQL Editor Only)
-- -----------------------------------------------------------------------------
-- This function is NOT executable by `anon` or `authenticated` roles.
-- Only `postgres` / `service_role` in the Supabase SQL Editor can invoke it.
create or replace function public.bootstrap_register_admin_email(
  p_admin_google_email text,
  p_notes text default 'مشرف حلقة سيدنا أبو بكر الصديق'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clean_email text := lower(btrim(p_admin_google_email));
  v_auth_uid uuid;
begin
  if v_clean_email is null or position('@' in v_clean_email) = 0 then
    raise exception 'INVALID_ADMIN_EMAIL: يرجى إدخال بريد Google صحيح للمشرف.';
  end if;

  select id into v_auth_uid
    from auth.users
   where lower(btrim(email)) = v_clean_email
   limit 1;

  insert into public.app_admins (email, user_id, notes)
  values (v_clean_email, v_auth_uid, p_notes)
  on conflict (email) do update
     set user_id = coalesce(excluded.user_id, public.app_admins.user_id),
         notes = excluded.notes;

  -- If the administrator has already signed in and created a profile, ensure status is approved
  if v_auth_uid is not null then
    update public.profiles
       set membership_status = 'approved',
           status_reason = 'حساب المشرف المعتمد',
           status_updated_at = now()
     where id = v_auth_uid;
  end if;
end;
$$;

-- Strictly revoke execution from client roles so no student can ever invoke it
revoke all on function public.bootstrap_register_admin_email(text, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Register Primary Administrator Google Email (hajij94@gmail.com)
-- -----------------------------------------------------------------------------
select public.bootstrap_register_admin_email(
  'hajij94@gmail.com',
  'المشرف العام لحلقة سيدنا أبو بكر الصديق (خالد حجيج)'
);

commit;
