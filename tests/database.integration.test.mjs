import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

let db;
const admin = '00000000-0000-4000-8000-000000000001';
const student = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
let challenge;
async function scalar(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
async function asUser(id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id, email: id === admin ? 'hajij94@gmail.com' : `${id}@example.com` })]);
  await db.exec('set role authenticated');
}
async function addUser(id, metadata = { admin_known_name: 'Student name', public_display_name: 'Student', leaderboard_opt_in: true }) {
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [id, id === admin ? 'hajij94@gmail.com' : `${id}@example.com`, JSON.stringify(metadata)]);
}
async function approve(id = student) {
  await asUser(admin);
  await db.query("select public.admin_set_membership_status($1,$2,'approved',null)", [id, challenge]);
  await asUser(id);
}
async function save(revision = 0) {
  return scalar('select public.save_today_achievement($1,public.get_damascus_today(),true,true,true,$2)', [challenge, revision]);
}
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text unique, raw_user_meta_data jsonb default '{}');
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  `);
  for (const name of fs.readdirSync('supabase/migrations').filter(x => x.endsWith('.sql')).sort()) {
    // PGlite includes core gen_random_uuid(); its WASM distribution does not ship pgcrypto.
    const sql = fs.readFileSync(`supabase/migrations/${name}`, 'utf8').replace(/create extension if not exists pgcrypto;/i, '');
    await db.exec(sql);
  }
});
beforeEach(async () => {
  await db.exec('reset role; begin');
  await addUser(admin); await addUser(student); await addUser(other);
  await db.query('select public.register_admin_user($1)', [admin]);
  challenge = await scalar("select id from public.challenges where not is_archived");
  await db.query('update public.challenges set start_date = public.get_damascus_today() where id=$1', [challenge]);
});
afterEach(async () => { await db.exec('rollback; reset role'); });
after(async () => { await db.close(); });

test('SQL: signup persists pending profile/membership without a browser session and ignores role metadata', async () => {
  assert.equal(await scalar('select membership_status from public.profiles where id=$1', [student]), 'pending');
  assert.equal(await scalar('select status from public.challenge_memberships where student_id=$1', [student]), 'pending');
  const id='00000000-0000-4000-8000-000000000099';
  await addUser(id,{admin_known_name:'Malicious name',public_display_name:'Name',membership_status:'approved',is_admin:true});
  await asUser(id);
  assert.equal(await scalar('select public.is_active_admin()'), false);
  assert.equal(await scalar('select membership_status from public.profiles where id=$1',[id]),'pending');
});
test('SQL: email whitelist alone grants no admin access and client cannot attest identities', async () => {
  await db.query('update public.app_admins set identity_verified_at=null where user_id=$1',[admin]);
  await asUser(admin);
  assert.equal(await scalar('select public.is_active_admin()'),false);
  const boot=await scalar('select public.get_session_bootstrap()');
  assert.equal(boot.is_admin,false);
  await assert.rejects(db.query('select public.register_admin_user($1)',[admin]), /permission denied/);
});
test('SQL: trusted admin provisioning repairs pending signup and permits daily saves', async () => {
  await asUser(admin);
  const boot=await scalar('select public.get_session_bootstrap()');
  assert.equal(boot.is_admin,true);
  assert.equal(boot.profile.membership_status,'approved');
  assert.equal(boot.challenge_membership_status,'approved');
  assert.equal((await save()).points,3);
});
test('SQL: pending/suspended users cannot invoke private streak helper', async () => {
  await asUser(student);
  await assert.rejects(db.query('select public.calculate_student_streak($1,$2,current_date,30,current_date)',[challenge,other]), /permission denied/);
});
test('SQL: missing and pending challenge memberships cannot save or enter rankings', async () => {
  await db.query("update public.profiles set membership_status='approved' where id=$1",[student]);
  await asUser(student);
  const board=await scalar('select public.get_leaderboard_and_group_stats($1)',[challenge]);
  assert.equal(board.approved_student_count,0);
  await db.exec('savepoint expected_failure');
  await assert.rejects(save(), /CHALLENGE_MEMBERSHIP_NOT_APPROVED/);
  await db.exec('rollback to savepoint expected_failure; reset role');
  await db.query('delete from public.challenge_memberships where student_id=$1',[student]);
  await asUser(student);
  await assert.rejects(save(), /CHALLENGE_MEMBERSHIP_NOT_APPROVED/);
});
test('SQL: real achievement revisions reject stale updates and maintain computed scores', async () => {
  await approve();
  const first=await save(); assert.equal(first.revision,1); assert.equal(first.points,3);
  assert.equal((await save(1)).revision,2);
  await assert.rejects(save(0), /STALE_REVISION/);
});
test('SQL: archived standings retain participation after later suspension and new signups', async () => {
  await approve(); await save();
  await asUser(admin);
  const next=await scalar("select public.admin_archive_and_create_challenge($1,'Next challenge',public.get_damascus_today(),30)",[challenge]);
  await db.query("select public.admin_set_membership_status($1,$2,'suspended',null)",[student,next.new_challenge.id]);
  await db.query("select public.admin_set_membership_status($1,$2,'approved',null)",[other,next.new_challenge.id]);
  const old=await scalar('select public.get_leaderboard_and_group_stats($1)',[challenge]);
  assert.equal(old.approved_student_count,1); assert.equal(old.group_total_points,3);
});
test('SQL: report includes all rows, excludes all trusted admins from standings, and denies students', async () => {
  await approve(); await asUser(admin);
  await db.exec('reset role');
  await db.query(`insert into public.daily_achievements(challenge_id,student_id,achievement_date,quran_two_pages)
    select $1,$2,public.get_damascus_today()-n,true from generate_series(0,1004) n`,[challenge,student]);
  await asUser(admin);
  const report=await scalar('select public.get_admin_report($1)',[challenge]);
  assert.equal(report.achievements.length,1005);
  assert.equal(report.profiles.find(p=>p.id===admin).is_admin,true);
  await asUser(student);
  await assert.rejects(db.query('select public.get_admin_report($1)',[challenge]), /ADMIN_ONLY/);
});
test('SQL: approval without current challenge and subsequent cycle creation work', async () => {
  await db.exec('update public.challenges set is_archived=true');
  await asUser(admin);
  await db.query("select public.admin_set_membership_status($1,null,'approved',null)",[student]);
  const next=await scalar("select public.admin_archive_and_create_challenge(null,'Recovery cycle',null,30)");
  assert.ok(next.new_challenge.id);
  assert.equal(await scalar('select status from public.challenge_memberships where student_id=$1 and challenge_id=$2',[student,next.new_challenge.id]),'approved');
});
test('SQL: trusted admin without a profile completes onboarding with approved membership', async () => {
  const id='00000000-0000-4000-8000-000000000088';
  await addUser(id,{});
  await db.query('select public.register_admin_user($1)',[id]);
  await asUser(id);
  const profile=await scalar("select public.upsert_my_profile('Second admin','Admin',false)");
  assert.equal(profile.membership_status,'approved');
  assert.equal((await save()).points,3);
  const leaderboard=await scalar('select public.get_leaderboard_and_group_stats($1)',[challenge]);
  assert.equal(leaderboard.approved_student_count,0);
});
test('SQL: real RLS prevents reading another profile and changing own membership status', async () => {
  await asUser(student);
  assert.equal(await scalar('select count(*) from public.profiles where id=$1',[other]),0);
  await assert.rejects(db.query("update public.profiles set membership_status='approved' where id=$1",[student]), /permission denied/);
});
test('SQL: dates stay locked after first achievement and stale archive requests are rejected', async () => {
  await approve(); await save(); await asUser(admin);
  await db.exec('savepoint invalid_config');
  await assert.rejects(db.query("select public.admin_configure_challenge($1,'Changed title',public.get_damascus_today()-1,30)",[challenge]), /CHALLENGE_LOCKED_AFTER_ACHIEVEMENTS/);
  await db.exec('rollback to savepoint invalid_config');
  await scalar("select public.admin_archive_and_create_challenge($1,'Next challenge',null,30)",[challenge]);
  await assert.rejects(db.query("select public.admin_archive_and_create_challenge($1,'Repeated request',null,30)",[challenge]), /CHALLENGE_INACTIVE/);
});
