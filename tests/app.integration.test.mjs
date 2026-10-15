import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { productionLoader } from './load-production.mjs';

const flush=()=>act(async()=>{await new Promise(setImmediate);});
const text=node=>typeof node==='string'?node:(node?.children??[]).map(text).join('');
function deferred(){let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function harness({status='approved',isAdmin=false}={}) {
  const state={user:'a',status,isAdmin,today:'2026-10-15',records:[],error:null,save:null,saveCalls:[],callback:null,recordRead:null,noChallenge:false,profileError:null,rpcCalls:[],reportReads:0};
  const timers=new Map(); let nextTimer=0;
  const boot=()=>({user_id:state.user,email:`${state.user}@example.com`,is_admin:state.isAdmin,
    damascus_today:state.today,challenge_membership_status:state.status,
    profile:{id:state.user,email:`${state.user}@example.com`,admin_known_name:state.user==='a'?'First student':'Second student',public_display_name:'Student',membership_status:state.status,leaderboard_opt_in:true},
    current_challenge:state.noChallenge?null:{id:'00000000-0000-4000-8000-000000000010',title:'Test challenge',community_name:'Community',start_date:'2026-10-01',duration_days:30,collective_goal_pct:80,is_archived:false}});
  const client={auth:{onAuthStateChange(callback){state.callback=callback;callback('INITIAL_SESSION',{user:{id:state.user}});return {data:{subscription:{unsubscribe(){}}}}},
    signOut:async()=>{state.user=null;state.callback('SIGNED_OUT',null);return {error:null}}},
    rpc:async(name,args)=>{
      state.rpcCalls.push({name,args});
      if(name==='get_session_bootstrap')return {data:boot(),error:state.error};
      if(name==='get_leaderboard_and_group_stats')return {data:{overall_rankings:[],weekly_rankings:[]},error:null};
      if(name==='get_admin_report'){state.reportReads++;return {data:{profiles:[],achievements:[],challenge:boot().current_challenge,damascus_today:state.today,generated_at:'2026-10-15T12:00:00Z'},error:null};}
      if(name==='upsert_my_profile')return {data:null,error:state.profileError};
      if(name==='save_today_achievement'){state.saveCalls.push(args);return state.save?state.save.promise:{data:{},error:null};}
      return {data:{},error:null};
    },
    from(){return {select(){return this},eq(){return this},then(resolve,reject){return (state.recordRead??Promise.resolve({data:state.records,error:null})).then(resolve,reject)}}},
  };
  const window={setInterval(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearInterval(id){timers.delete(id)},addEventListener(){},removeEventListener(){}};
  const document={visibilityState:'visible',addEventListener(){},removeEventListener(){},body:{appendChild(){},removeChild(){}},createElement(){return {click(){}}}};
  const icons=new Proxy({}, {get:()=>()=>React.createElement('svg')});
  const load=productionLoader({'lucide-react':icons,[path.resolve('src/lib/supabase.ts')]:{supabase:client,isSupabaseConfigured:true}},{window,document,Blob,URL});
  const App=load('src/App.tsx').default;
  let renderer; await act(async()=>{renderer=TestRenderer.create(React.createElement(App));});
  await flush();
  return {state,renderer,client,
    buttons:()=>renderer.root.findAllByType('button'),
    button(label){const b=this.buttons().find(b=>text(b).includes(label));assert.ok(b,`Missing button: ${label}`);return b;},
    async click(label){await act(async()=>{this.button(label).props.onClick();});await flush();},
    async poll(){await act(async()=>{for(const fn of timers.values())fn();});await flush();},
    async event(event,user=state.user){await act(async()=>{state.callback(event,user?{user:{id:user}}:null)});await flush();},
    close(){act(()=>renderer.unmount());},
  };
}
test('React: token refresh and background reads preserve unsaved activities and profile input',async()=>{
  const h=await harness(); try {
    await h.click('قراءة صفحتين');
    assert.match(text(h.renderer.toJSON()),/تغييرات غير محفوظة/);
    await h.event('TOKEN_REFRESHED'); await h.poll();
    assert.match(text(h.renderer.toJSON()),/تغييرات غير محفوظة/);
    await h.click('الملف الشخصي');
    const input=h.renderer.root.findAllByType('input').find(x=>x.props.value==='First student');
    act(()=>input.props.onChange({target:{value:'Unsaved new name'}}));
    await h.poll();
    assert.ok(h.renderer.root.findAllByType('input').some(x=>x.props.value==='Unsaved new name'));
  } finally {h.close();}
});
test('React: changing account clears old data and ignores late responses from old account',async()=>{
  const h=await harness(); try {
    await h.click('قراءة صفحتين');
    const pending=deferred(); h.state.recordRead=pending.promise;
    await h.poll();
    h.state.user='b'; h.state.status='pending'; h.state.recordRead=null;
    await h.event('SIGNED_IN','b');
    pending.resolve({data:[{id:'old',challenge_id:'00000000-0000-4000-8000-000000000010',student_id:'a',achievement_date:h.state.today,quran_two_pages:true,revision:4}],error:null});
    await flush();
    const rendered=text(h.renderer.toJSON());
    assert.match(rendered,/Second student/); assert.doesNotMatch(rendered,/First student|تغييرات غير محفوظة/);
  } finally {h.close();}
});
test('React: mutation lock disables edits and rejects duplicate save calls',async()=>{
  const h=await harness(); try {
    await h.click('قراءة صفحتين'); h.state.save=deferred();
    await h.click('حفظ إنجاز اليوم');
    assert.equal(h.renderer.root.findByType('fieldset').props.disabled,true);
    assert.equal(h.button('قراءة صفحتين').props.disabled,true);
    const save=h.buttons().find(b=>text(b).includes('جاري الحفظ'));
    act(()=>{void save.props.onClick();}); assert.equal(h.state.saveCalls.length,1);
    h.state.save.resolve({data:{},error:null}); await flush();
    assert.equal(h.renderer.root.findByType('fieldset').props.disabled,false);
  } finally {h.close();}
});
test('React: polling advances the server day and does not carry yesterday draft into today',async()=>{
  const h=await harness(); try {
    await h.click('قراءة صفحتين'); h.state.today='2026-10-16'; await h.poll();
    assert.match(text(h.renderer.toJSON()),/2026-10-16/);
    assert.doesNotMatch(text(h.renderer.toJSON()),/لديك تغييرات غير محفوظة/);
    await h.click('حفظ إنجاز اليوم');
    assert.equal(h.state.saveCalls[0].p_target_date,'2026-10-16');
    assert.equal(h.state.saveCalls[0].p_quran_two_pages,false);
    assert.equal(h.state.saveCalls[0].p_expected_revision,0);
  } finally {h.close();}
});
test('React: pending approval refreshes automatically; bootstrap failures show retry instead of old data',async()=>{
  const h=await harness({status:'pending'}); try {
    assert.match(text(h.renderer.toJSON()),/قيد المراجعة/);
    h.state.status='approved'; await h.poll(); assert.ok(h.button('حفظ إنجاز اليوم'));
    h.state.error={message:'Database unavailable'}; await h.poll();
    assert.match(text(h.renderer.toJSON()),/Database unavailable/);
    assert.ok(h.button('إعادة المحاولة'));
    assert.ok(!h.buttons().some(b=>text(b).includes('حفظ إنجاز اليوم')));
    h.state.error=null; await h.click('إعادة المحاولة'); assert.ok(h.button('حفظ إنجاز اليوم'));
  } finally {h.close();}
});
test('React: profile errors remain visible and dirty input survives a failed save',async()=>{
  const h=await harness({status:'pending'}); try {
    const input=h.renderer.root.findAllByType('input').find(x=>x.props.value==='First student');
    act(()=>input.props.onChange({target:{value:'Edited name'}}));
    h.state.profileError={message:'Profile save failed'};
    await act(async()=>{await h.renderer.root.findByType('form').props.onSubmit({preventDefault(){}});});
    assert.match(text(h.renderer.toJSON()),/Profile save failed/);
    assert.ok(h.renderer.root.findAllByType('input').some(x=>x.props.value==='Edited name'));
  } finally {h.close();}
});
test('React: exports fetch a fresh server report and no-current-challenge settings are disabled',async()=>{
  const h=await harness({isAdmin:true}); try {
    await h.click('لوحة المشرف');
    const reads=h.state.reportReads;
    await h.click('تصدير CSV');
    assert.equal(h.state.reportReads,reads+1);
    h.state.noChallenge=true; await h.poll();
    assert.equal(h.button('حفظ إعدادات التحدي').props.disabled,true);
  } finally {h.close();}
});
