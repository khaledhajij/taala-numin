# Apply the logic and security fixes

These changes are local until you apply the SQL migration and redeploy. No live Supabase database was modified by this work.

## Existing project

1. Apply `supabase/migrations/20261015000005_signup_requests.sql` if it has not already been applied.
2. Apply `supabase/migrations/20261015000006_logic_and_security.sql` in Supabase SQL Editor as the database administrator.
3. Apply `supabase/migrations/20261015000007_all_users_in_leaderboard.sql` in Supabase SQL Editor to include all approved students on the leaderboard and remove optional choosing.
4. Explicitly attest each real admin account using the steps below. **Existing email-linked admins lose admin privileges until this step is completed.** Student profiles, approval statuses and achievements are preserved. Admin identities are not automatically trusted because an old email match does not prove account ownership.
5. Redeploy the frontend with the existing Supabase public URL/key environment variables.

For a new project, apply all seven migrations in filename order before exposing the application, then create and attest the admin account.

## Attest your admin identity

Sign into your real account and verify that you control it. In Supabase Authentication > Users, locate its UUID and confirm that it belongs to the intended administrator. Do not approve an unknown account solely because its email matches the old whitelist; email confirmation may previously have been disabled.

Run this in SQL Editor, replacing the placeholder with that verified UUID:

```sql
select public.register_admin_user('YOUR_VERIFIED_AUTH_USER_UUID'::uuid);
```

This SQL-only operation approves an existing admin profile and its current challenge membership. If the account has no profile yet, complete onboarding after registration. The browser's anon/authenticated roles cannot execute this function. Repeat for additional administrators. Existing identities can be inspected with:

```sql
select email, user_id, identity_verified_at
from public.app_admins
order by email;
```

Refresh the application; the admin panel should appear. Keep email confirmation enabled to verify student email ownership. Signup requests are saved even before email confirmation, but a student still needs an authenticated session and explicit approval to access protected data.

## Behavior after deployment

- New requests persist in the signup transaction. Older accounts without saved names must complete onboarding; missing names are not fabricated.
- Profiles and challenge memberships are separate: saving requires global approval and approval for the current challenge. Existing current-challenge membership rows are preserved; missing rows are backfilled from the existing profile status.
- Archived challenge standings use their membership rows; future signups and later global suspensions no longer change who participated.
- Admin identities are excluded from student rankings/reports using the registry, not hardcoded email strings. Admins can record personal activities.
- Data refreshes every 15 seconds while visible and on focus. Dirty same-day forms are retained. At a day/challenge change, old activity drafts are cleared with a notice rather than copied into the new day.
- A stale-save error keeps the local draft. Use “تحميل أحدث سجل واستبدال التعديلات المحلية” to explicitly load the latest version before editing again.
- Reports are read from a guarded JSON RPC in one database statement, avoiding the API row cap. Export fetches a fresh report before generating the CSV.
- If there is no current challenge, global approvals still work; use the new-cycle action to create one. Current-challenge configuration is disabled until a challenge exists.
- All approved students appear on the public leaderboard. The optional opt-in choice and checkboxes have been completely removed.

## Validation

```sh
npm test
npm run test:db
npm run build
```

The database suite executes all migrations in embedded PostgreSQL (PGlite) with Supabase-style auth functions and anon/authenticated roles. It uses PostgreSQL's core UUID generator instead of installing pgcrypto. It is not a hosted Supabase Auth/PostgREST test and cannot reproduce separate-connection transaction races. The save RPC serializes each student's writes by locking their profile before checking for an achievement row; its stale-revision behavior is exercised in the SQL suite.

After deployment, verify a signup with email confirmation enabled, student approval in a second browser, an admin personal save, and an export. Hosted email delivery and existing project grants/configuration still require that live check.
