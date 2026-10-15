# Logic audit — 2026-10-15

**Implementation update:** the findings below are the pre-fix audit. Fixes now reside in `src/App.tsx`, `src/lib/appData.ts`, `src/lib/domainLogic.ts`, and migration `20261015000006_logic_and_security.sql`. Production-module, React and embedded PostgreSQL regression tests were added. Apply the migration and attest admin UUIDs using [DEPLOYMENT_FIXES.md](DEPLOYMENT_FIXES.md); live deployment remains outstanding.

Scope: current working tree, including the pending signup migration; React state and forms, domain calculations, all five SQL migrations, RLS/grants, and tests. Application source and migrations were not changed during this audit.

Validation: `npm run build` and all 13 existing tests pass. The actual TypeScript domain module was transpiled and executed to verify the short-final-week calculation. SQL findings are source-confirmed control-flow/permission issues, not live database reproductions. Supabase deployment state, auth settings, function ownership and database grants were not available for verification.

Priority: P1 = address before relying on the affected security/data behavior; P2 = functional defect; P3 = display defect.

## 1. P1 — Email-only admin bootstrap is unsafe with the documented auth configuration

Evidence: `supabase/migrations/20261014000002_rls_and_grants.sql:16`, `20261014000001_initial_schema.sql:245`, `20261014000003_rpc_functions.sql:34`, and `README.md:29`.

The README instructs disabling email confirmation. Meanwhile an email match links an auth user to the admin registry and grants admin privileges. If a whitelisted email has not yet been registered, someone can register it without proving mailbox ownership and receive admin access. This is conditional on the account being available and confirmation being disabled; it is not evidence that an existing admin account has been compromised.

Fix: provision and verify the admin identity through a trusted flow, authorize by its linked user ID, and remove automatic privilege assignment based on an unverified email. Merely checking `email_confirmed_at` is insufficient when confirmation is disabled: Supabase implicitly confirms these accounts.

Source: [Supabase auth configuration](https://supabase.com/docs/guides/auth/general-configuration).

## 2. P1 — Exposed streak helper bypasses student privacy and suspension checks

Evidence: `supabase/migrations/20261014000003_rpc_functions.sql:344` and `:413`.

`calculate_student_streak` is SECURITY DEFINER, accepts an arbitrary student ID and dates, and grants execution to every authenticated user. It never checks the caller's identity, approval, suspension, or whether they may inspect the target student. With a known target UUID, a pending or suspended account can probe another student's completed-day streaks, including historical dates. Table RLS does not protect reads made by this privileged function under the intended migration ownership.

Fix: revoke client execution if this is an internal helper, or explicitly restrict calls to an approved student querying themselves or an authorized admin. Derive challenge boundaries internally.

Source: [Supabase database function permissions](https://supabase.com/docs/guides/database/functions).

## 3. P2 — New signup trigger leaves admin membership pending

Evidence: `supabase/migrations/20261015000005_signup_requests.sql:25`, `20261014000003_rpc_functions.sql:128`, `:140`, and `:226`.

This is a regression introduced by the preceding request-list fix. The trigger creates every profile and challenge membership as pending. The subsequent profile RPC only assigns approved status when inserting a missing profile, so it preserves the admin's existing pending status. The UI lets admins use the daily-entry page, but the save RPC rejects them with MEMBERSHIP_PENDING. The primary admin is filtered out of the membership controls, so there is no ordinary self-approval action there.

Fix: establish explicit admin participation semantics, and reconcile admin membership using the trusted registry rather than user metadata. Include fresh-admin signup in the regression tests.

## 4. P1 — Account changes can retain another account's data

Evidence: `src/App.tsx:187`, `:239`, `:251`, `:268`, and `:496`.

Sign-out clears only a subset of session state. Achievements, rankings, admin datasets, form values, selected tab and drafts remain. On a later login, failed achievement/leaderboard queries leave the old data intact because errors are ignored and setters only run when data is returned. An approved second user can therefore see the previous user's dashboard data after a failed fetch. A bootstrap started before logout also has no identity/version guard preventing late results from restoring old state.

Fix: clear all account-scoped state on identity changes; associate requests with a session generation and discard stale responses; fail closed when required bootstrap data cannot load.

## 5. P2 — Auth refreshes discard unsaved edits

Evidence: `src/App.tsx:218`, `:235`, `:324`, and `:349`.

Every auth event triggers a full bootstrap, including token refresh and same-user SIGNED_IN events. Bootstrap overwrites profile/config inputs and creates new achievement objects. The savedToday effect then replaces the activity draft even if the fetched values have not changed. Editing a form or ticking an activity and then triggering an auth refresh can silently erase those edits. The installed auth client documents SIGNED_IN on tab refocus as well.

Fix: distinguish identity changes from token refresh, preserve dirty form/draft state, and update drafts only when their account/challenge/date changes or the user explicitly accepts refreshed data.

## 6. P2 — Open pages do not reliably advance at midnight or react to approval

Evidence: `src/App.tsx:204`, `:330`, `:533`, and `:961`.

The displayed Damascus date changes only during bootstrap. A page left open across midnight keeps yesterday's date and submits it; the server correctly rejects the save, but the error branch does not refresh the date. A pending student also has no membership refresh timer/button, so approval in another browser does not itself unlock their page. Auth events or reloads can eventually refresh both, but are not tied to these changes.

Fix: refresh server date/status on appropriate visibility and rollover events, provide a waiting-screen refresh action, and handle expired-day/conflict responses with explicit recovery while preserving the user's intent.

## 7. P2 — Errors are hidden in several important flows

Evidence: `src/App.tsx:240`, `:288`, `:313`, `:513`, `:796`, and `:913`.

Achievement, leaderboard and admin-achievement queries discard their errors. Bootstrap failures go to authError, which is rendered only while logged out, although sessionUserId has already been set. The initial profile form does not render profileFeedback at all. For example, submitting a one-character onboarding name fails the RPC with no visible explanation. These paths can present blank/stale data as if loading succeeded.

Fix: represent loading/error/empty states separately, render errors on the active screen, and offer a retry for the failed operation.

## 8. P2 — Save-in-flight edits can be lost and repeated submissions allowed

Evidence: `src/App.tsx:526`, `:549`, `:1084`, and `:1135`.

Activity buttons remain enabled during saving, and toggling one sets saveStatus back to idle. A student can save, change another activity while the request is pending, and then have that newer edit overwritten when the first save's bootstrap reloads the earlier snapshot. Resetting saveStatus also re-enables the save button before the original request finishes. Admin actions similarly have no pending guard against repeated clicks.

Fix: use an independent mutation-in-flight flag and either disable edits while saving or preserve changes made after the submitted snapshot. Add guards to admin mutations.

## 9. P2 — Challenge membership is enforced inconsistently

Evidence: `supabase/migrations/20261014000003_rpc_functions.sql:249`, `:475`, and `:626`; `src/lib/domainLogic.ts:336`.

Saving rejects an existing non-approved challenge membership but accepts a missing membership. Rankings and group denominators ignore challenge memberships entirely and include every globally approved profile. Thus a student with a pending challenge membership cannot save but still counts in that challenge's standings/denominator. Historical rankings also change when new profiles are globally approved or old participants are suspended later.

Fix: decide whether approval is global-only or per challenge, then apply that rule consistently to writes, standings and historical reporting. If per-challenge membership is intended, require an approved row and use it to select participants.

## 10. P2 — Admin totals and exports can be incomplete or stale

Evidence: `src/App.tsx:288`, `:330`, `:398`, and `:615`.

The new refresh only reloads profiles, not achievements. An admin can receive new student requests while still exporting achievement totals from the original page load. Also, the all-achievements query has no pagination. Under Supabase's default 1,000-row API cap, 34 students recording all 30 days produce 1,020 records, so local totals and CSV exports silently omit some records. The server aggregate need not have the same truncation, making views disagree.

Fix: fetch complete, consistently ordered pages or calculate/export server-side; refresh report data before export and show when it was last loaded. Verify the deployed API row limit.

Source: [Supabase select limits](https://supabase.com/docs/reference/javascript/v1/select).

## 11. P2 — Approval fails if there is no current challenge

Evidence: `src/App.tsx:77`, `:207`, and `:561`.

The preceding fix allows the admin list to load without a challenge, but approval still sends `default-challenge`, which is not a UUID. The RPC accepts a nullable challenge ID and could update global status without one; the frontend never sends null. Bootstrap also retains the previous challenge if a later response has no current challenge.

Fix: model an absent challenge explicitly, reset its state, send null for global approval, and disable challenge-specific actions until a valid challenge exists. The normal seed creates a challenge, so this affects missing/archived-current-challenge states.

## 12. P3 — Final-week maximum is incorrect

Evidence: `src/App.tsx:1160`; `src/lib/domainLogic.ts:307`.

The UI hardcodes weekly points out of 21. In a 30-day challenge, week five contains only days 29 and 30, so its maximum is 6. Executing the actual domain module confirmed currentWeekMaxPoints = 6 for day 30 while the UI still uses 21.

Fix: render dashboardMetrics.currentWeekMaxPoints. Other fixed 30-day/90-point labels should also follow challenge configuration if the SQL-supported 7–90-day durations remain supported.

## Additional edge cases

- `src/App.tsx:451` checks only minimum name lengths; there are no input maximums. The signup trigger silently skips profiles above the SQL limits of 80/50 characters, recreating a missing-request case until onboarding is corrected. Validate both bounds before creating the auth account.
- `src/App.tsx:402`, `:618`, and `:1414` use hardcoded admin-email exclusions. Additional registered admins are inconsistently counted in local statistics, exports and member controls compared with the SQL leaderboard. Use the authoritative admin registry or server-returned participant list.
- `20261014000003_rpc_functions.sql:271` locks an existing achievement row, but cannot lock a row that does not exist. Two first saves can both pass the absence check; one then fails with a unique-constraint error rather than the intended STALE_REVISION response. The unique constraint still prevents duplicate records. Test this with two real database sessions and serialize or normalize the conflict.

## Test coverage gap and recommended validation

`tests/domain_and_security.test.mjs:90` defines its own SecureDatabaseSimulator. Its tests do not execute SQL policies/RPCs or React flows, and domain helpers are copied into the test file rather than imported from production. The final test checks SQL text patterns and does not inspect migration 00005. Passing these tests does not establish live security correctness.

Add production-domain tests, UI tests with controlled auth/network events, and a disposable PostgreSQL/Supabase integration suite. Prioritize: unauthorized streak calls; trusted-admin provisioning; fresh admin/student signup with confirmation on/off; account switching with failed or delayed responses; dirty edits across auth events; midnight rollover; student approval refresh; overlapping saves; per-challenge membership; paginated exports; and the final week.

Recommended repair order: admin identity and RPC privacy; account isolation; signup/admin regression; lifecycle and save handling; consistent membership/reporting; remaining validation/display fixes.
