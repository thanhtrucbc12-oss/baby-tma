import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createRequire } from 'node:module';
const { createAnalytics } = createRequire(import.meta.url)('../analytics.js');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
}
const ack = options => ({ ok:true, json:async () => ({ accepted_ids: JSON.parse(options.body).events.map(e=>e.id) }) });

test('analytics flush preserves events arriving in flight and splits every batch at 20', async () => {
  const local = storage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent = [];
  const analytics = createAnalytics({ storage:local,endpoint:'test',fetch:async (_, options) => {
    const events = JSON.parse(options.body).events;
    assert.ok(events.length <= 20);
    sent.push(...events);
    if (sent.length === 20) await gate;
    return ack(options);
  } });
  for (let n=0; n<81; n++) analytics.track('app_open');
  const first = analytics.flush();
  assert.equal(analytics.flush(), first, 'only one sender at a time');
  analytics.track('notifications_disabled');
  release(); await first;
  assert.equal(sent.length,82);
  assert.equal(new Set(sent.map(e=>e.id)).size,82);
  assert.equal(analytics._readQueue().length,0);
});

test('analytics rejects old-owner and legacy queues; late ACK does not clear new owner events', async () => {
  const local = storage({ babymode_local_owner_v1:'101',babymode_baby_name:'PRIVATE',babymode_analytics_queue:JSON.stringify([{id:'legacy',baby:{name:'PRIVATE'}}]) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sent=[];
  const analytics=createAnalytics({storage:local,endpoint:'test',fetch:async (_,options)=>{sent.push(JSON.parse(options.body));await gate;return ack(options);}});
  assert.equal(analytics._readQueue().length,0);
  analytics.track('app_open');
  const pending=analytics.flush();
  local.setItem('babymode_local_owner_v1','202');
  analytics.track('premium_opened');
  release();
  assert.equal(await pending,false);
  assert.equal(analytics._readQueue().length,1);
  assert.equal(analytics._readQueue()[0]._owner,'202');
  assert.equal(JSON.stringify(sent).includes('PRIVATE'),false);
  await analytics.flush();
  assert.equal(sent[1].events[0]._owner,'202');
});

test('partial ACK leaves unacknowledged events for retry', async()=>{
  const local=storage();
  let calls=0;
  const analytics=createAnalytics({storage:local,endpoint:'test',fetch:async(_,options)=>{
    const events=JSON.parse(options.body).events;
    return {ok:true,json:async()=>({accepted_ids:++calls===1?[events[0].id]:[]})};
  }});
  analytics.track('app_open');analytics.track('profile_saved');
  assert.equal(await analytics.flush(),false);
  assert.equal(analytics._readQueue().length,1);
});

test('cloud pull preserves legacy diary and respects explicit tombstones', async () => {
  const local=storage({babymode_logs:JSON.stringify([{date:'2026-09-01',dayNaps:60},{date:'2026-09-02',dayNaps:40}])});
  const window={BABY_SYNC_ENDPOINT:'test',addEventListener(){},BabyAccount:{canUseServer:()=>true,
    request:async()=>({ok:true,json:async()=>({ok:true,diary:[],deleted_diary_days:[{date:'2026-09-02',_updatedAt:'2026-09-03T00:00:00Z'}]})})}};
  vm.runInNewContext(fs.readFileSync('cloud-sync.js','utf8'),{window,localStorage:local,Date,Intl,setTimeout,clearTimeout});
  await window.BabyCloudSync.syncNow();
  const diary=JSON.parse(local.getItem('babymode_logs'));
  assert.equal(diary.length,1); assert.equal(diary[0].dayNaps,60); assert.ok(diary[0]._updatedAt);
});

test('analytics endpoint cannot mutate canonical profiles or notification consent', async () => {
  const writes=[];
  const db={rpc:async()=>({data:true}),from:table=>{
    const q={upsert(value){writes.push({table,value});return q;},insert(value){writes.push({table,value});return q;},
      select(){return q;},single:async()=>({data:{id:'synthetic-user'}}),then:resolve=>Promise.resolve({error:null}).then(resolve)};
    return q;
  }};
  const context={Date,Request,Response,TextEncoder,crypto,console,createClient:()=>db,
    clientAddress:()=>'',readJsonBody:async req=>({ok:true,value:await req.json()}),
    authenticateAppRequest:async()=>({ok:true,telegramId:123,user:{}}),
    Deno:{env:{get:()=> 'synthetic'},serve:handler=>{context.handler=handler;}}};
  const source=fs.readFileSync('supabase/functions/analytics-events/index.ts','utf8').replace(/^import .*;\n/gm,'');
  vm.runInNewContext(stripTypeScriptTypes(source),context);
  const response=await context.handler(new Request('https://example.test',{method:'POST',headers:{authorization:'synthetic'},body:JSON.stringify({events:[
    {id:'one',event:'app_open',baby:{name:'STALE',birthdate:'2025-01-01'}},
    {id:'two',event:'notifications_enabled',baby:{},payload:{schedule_reminders:true}}
  ]})}));
  assert.equal(response.status,200);
  assert.equal(writes.some(w=>w.table==='babies'||w.table==='notification_settings'),false);
  assert.equal(writes.some(w=>w.table==='events'&&w.value.baby_name),false);
  assert.deepEqual((await response.json()).accepted_ids,['one','two']);
});
