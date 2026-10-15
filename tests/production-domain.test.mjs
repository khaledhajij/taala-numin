import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionLoader } from './load-production.mjs';
const load=productionLoader();
const domain=load('src/lib/domainLogic.ts');
const {validateProfileNames,errorMessage,mapReport}=load('src/lib/appData.ts');
const ch={id:'c',title:'Test',startDate:'2026-10-01',durationDays:30,collectiveGoalPct:80,isArchived:false};
test('production domain: final week has six available points',()=> {
  const metrics=domain.calculatePersonalDashboard(ch,[],'2026-10-30');
  assert.equal(metrics.currentWeekMaxPoints,6);
  assert.equal(domain.evaluateChallengeWindow(ch,'2026-09-30').state,'upcoming');
  assert.equal(domain.evaluateChallengeWindow(ch,'2026-10-31').state,'completed');
});
test('production domain: standings require challenge membership and exclude every admin',()=> {
  const base={email:'s@example.com',publicDisplayName:'Student',membershipStatus:'approved',leaderboardOptIn:true};
  const students=[{...base,id:'missing'}, {...base,id:'pending',challengeMembershipStatus:'pending'},
    {...base,id:'approved',challengeMembershipStatus:'approved'},
    {...base,id:'admin',challengeMembershipStatus:'approved',isAdmin:true}];
  const result=domain.computeLeaderboardAndGroupStats(ch,students,[],[],null,'2026-10-15');
  assert.equal(result.approvedStudentCount,1);
  assert.equal(result.overallRankings.length,1);
});
test('production domain: archived membership survives later global suspension',()=> {
  const students=[{id:'s',email:'s@example.com',publicDisplayName:'Student',membershipStatus:'suspended',challengeMembershipStatus:'approved',leaderboardOptIn:true}];
  assert.equal(domain.computeLeaderboardAndGroupStats({...ch,isArchived:true},students,[],[],null,'2026-11-01').approvedStudentCount,1);
});
test('production validation: enforce both name bounds and count Unicode characters',()=> {
  assert.ok(validateProfileNames('x','Valid')); assert.ok(validateProfileNames('x'.repeat(81),'Valid'));
  assert.ok(validateProfileNames('Valid','x'.repeat(51)));
  assert.equal(validateProfileNames('x'.repeat(80),'x'.repeat(50)),null);
  assert.equal(validateProfileNames('😀'.repeat(80),'Valid'),null);
  assert.equal(errorMessage({message:'Permission denied'}),'Permission denied');
});
test('production report mapping retains every row and authoritative admin/membership flags',()=> {
  const report=mapReport({profiles:[{id:'a',is_admin:true,challenge_membership_status:'approved'}],achievements:Array.from({length:1005},(_,i)=>({id:i,revision:1,points:3})),challenge:null,damascus_today:'2026-10-15',generated_at:'now'});
  assert.equal(report.achievements.length,1005); assert.equal(report.profiles[0].isAdmin,true);
  assert.equal(report.profiles[0].challengeMembershipStatus,'approved'); assert.equal(report.challenge.id,'');
});
