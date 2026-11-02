import test from 'node:test';
import assert from 'node:assert/strict';
import {Activity,AlwaysOn as alwaysOn} from '../../../controller/tenant-compute/src/domain/compute/Activity.mjs';
const database=(name,sessions='1',active_ms='0')=>({name,sessions,active_ms,reset:'same'});
const sample=(clients=[],databases=[database('app')])=>({clients,databases,blockers:false});
test('Five-minute policy suspends idle pooled connections only after observed SQL inactivity',()=>{
  let now=0;const tracker=new Activity(()=>now),endpoint={suspend:{mode:'idle',idleSeconds:300}};
  const idle={pid:10,database:'app',state:'idle',change:'query-finished'};
  assert.equal(tracker.observe(sample([idle]),endpoint),false);
  now=299999;assert.equal(tracker.observe(sample([idle]),endpoint),false);
  now=300000;assert.equal(tracker.observe(sample([idle]),endpoint),true);
});
test('Work in short-lived connections resets inactivity even when no backend remains',()=>{
  let now=0;const tracker=new Activity(()=>now),endpoint={suspend:{mode:'idle',idleSeconds:300}};
  tracker.observe(sample(),endpoint);now=290000;
  assert.equal(tracker.observe(sample([],[database('app','2','3')]),endpoint),false);
  now=300000;assert.equal(tracker.observe(sample([],[database('app','2','3')]),endpoint),false);
});
test('Open transactions and active queries prevent suspension',()=>{
  let now=0;const tracker=new Activity(()=>now),endpoint={suspend:{mode:'idle',idleSeconds:1}};
  tracker.observe(sample(),endpoint);now=5000;
  for(const state of ['active','idle in transaction','idle in transaction (aborted)'])
    assert.equal(tracker.observe(sample([{pid:1,database:'app',state,change:'old'}]),endpoint),false);
});
test('A never-suspend database keeps the shared compute alive',()=>{
  const endpoint={suspend:{mode:'idle',idleSeconds:300},databasePolicies:{billing:{mode:'never'}}};
  assert(alwaysOn(endpoint));let now=0;const tracker=new Activity(()=>now);
  tracker.observe(sample(),endpoint);now=86400000;assert.equal(tracker.observe(sample(),endpoint),false);
});
test('Shared compute waits for the individual timeout of every database',()=>{
  let now=0;const tracker=new Activity(()=>now);
  const endpoint={suspend:{mode:'idle',idleSeconds:300},databasePolicies:{archive:{mode:'idle',idleSeconds:600}}};
  const snapshot=sample([],[database('app'),database('archive')]);
  tracker.observe(snapshot,endpoint);now=300000;assert.equal(tracker.observe(snapshot,endpoint),false);
  now=600000;assert.equal(tracker.observe(snapshot,endpoint),true);
});
