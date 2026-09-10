import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseScenario } from '../dist/lab/schema.js';
import { SimulatedLedger } from '../dist/lab/simulated.js';
import { runScenario, prepareScenarios } from '../dist/lab/runner.js';
import { runLabGate } from '../dist/lab/gate.js';
import { renderLabReport } from '../dist/lab/report.js';
import { startBridge } from '../dist/lab/bridge.js';
import { stringify } from 'yaml';
const base = () => ({schemaVersion:1,name:'Test',network:{mode:'simulated'},fixtures:{accounts:{alice:{hbar:10},bob:{hbar:0}},tokens:{ticket:{treasury:'alice',supply:1}},topics:['wall']},timeoutMs:50,pollIntervalMs:5,steps:[{id:'owner',assert:{type:'nftOwner',token:'ticket',serial:1,account:'alice'}}]});
async function inTemp(fn) { const dir=await mkdtemp(path.join(tmpdir(),'lab-test-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});} }
async function run(scenario, dir) {const file=path.join(dir,'scenario.yaml');await writeFile(file,stringify(scenario));return runScenario({file,workspace:dir,outputDirectory:path.join(dir,'report')});}
test('schema rejects silent omissions, invalid references and unsafe endpoints',()=>{
  const mutations=[s=>s.steps[0].id="cleanup",s=>s.fixtures.accounts.alice.hbar=0.000000001,s=>s.steps=[],s=>s.steps.push({...s.steps[0]}),s=>s.steps[0].assert.type='nftOwnership',s=>s.fixtures.accounts.alice.hbar=-1,s=>s.fixtures.accounts.alice.hbar=Infinity,s=>s.steps[0].assert.account='missing',s=>s.steps[0].assert.typo=true,s=>s.network.mode='mainnet',s=>{s.network={mode:'local',nodeAddress:'remote:50211',nodeAccountId:'0.0.3',mirrorUrl:'http://localhost:8081'};},s=>{s.network={mode:'testnet'};s.faults={mirrorDelayMs:1};},s=>{s.steps=[{id:'action',operation:{type:'associate',actor:'bob',token:'ticket'}}];},s=>{s.steps[0].expectStatus='SUCCESS';}];
  for(const mutate of mutations){const s=base();mutate(s);assert.throws(()=>parseScenario(s));}
});
test('fresh simulator rejects transfer before association and preserves ownership',async()=>{
  const s=parseScenario(base());const ledger=new SimulatedLedger(s.faults);await ledger.provision(s.fixtures);
  const transfer={type:'transferNft',actor:'alice',to:'bob',token:'ticket',serial:1};
  assert.equal((await ledger.execute(transfer)).status,'TOKEN_NOT_ASSOCIATED_TO_ACCOUNT');
  assert.equal((await ledger.observe(s.steps[0].assert)).matches,true);
  await ledger.execute({type:'associate',actor:'bob',token:'ticket'});
  assert.equal((await ledger.execute(transfer)).status,'SUCCESS');
  assert.equal((await ledger.execute(transfer)).status,'SENDER_DOES_NOT_OWN_NFT_SERIAL_NO');
  ledger.close();
});
test('negative expectation passes only for exact status',()=>inTemp(async dir=>{
  const s=base();s.steps.unshift({id:'transfer',operation:{type:'transferHbar',actor:'bob',to:'alice',amount:1},expectStatus:'INSUFFICIENT_ACCOUNT_BALANCE'});
  assert.equal((await run(s,dir)).passed,true);
  s.steps[0].expectStatus='SUCCESS';const report=await run(s,dir);
  assert.equal(report.passed,false);assert.equal(report.events.find(e=>e.id==='owner').status,'skipped');
}));
test('mirror polling observes delayed message and times out on missing state',()=>inTemp(async dir=>{
  const s=base();s.faults={mirrorDelayMs:35};s.timeoutMs=200;
  s.steps=[{id:'submit',operation:{type:'submitMessage',actor:'alice',topic:'wall',message:'unique'}},{id:'message',assert:{type:'topicMessage',topic:'wall',message:'unique'}}];
  const report=await run(s,dir);assert.equal(report.passed,true);assert.ok(report.events.find(e=>e.id==='message').evidence.polls>1);
  s.steps[1].assert.message='absent';s.timeoutMs=30;assert.equal((await run(s,dir)).passed,false);
}));
test('run isolation prevents matching evidence from a prior scenario',()=>inTemp(async dir=>{
  const s=base();s.steps=[{id:'submit',operation:{type:'submitMessage',actor:'alice',topic:'wall',message:'old'}},{id:'message',assert:{type:'topicMessage',topic:'wall',message:'old'}}];
  assert.equal((await run(s,dir)).passed,true);s.steps.shift();assert.equal((await run(s,dir)).passed,false);
}));
test('gate rejects an agent weakening or removing its scenario contract',()=>inTemp(async dir=>{
  const file=path.join(dir,'scenario.yaml');await writeFile(file,stringify(base()));const prepared=await prepareScenarios([file]);
  await writeFile(file,stringify({...base(),name:'changed'}));
  const result=await runLabGate({workspace:dir,files:[file],prepared,output:path.join(dir,'reports')});
  assert.equal(result.passed,false);assert.match(result.findings[0].id,/contract-modified/);
}));
test('live mode without credentials aborts, never falls back to simulation',()=>inTemp(async dir=>{
  const s=base();s.network={mode:'testnet',operatorIdEnv:'LAB_TEST_MISSING_ID',operatorKeyEnv:'LAB_TEST_MISSING_KEY'};
  const r=await run(s,dir);assert.equal(r.passed,false);assert.equal(r.infrastructureFailure,true);assert.equal(r.mode,'testnet');
}));
test('HTML evidence escapes hostile application data',()=>inTemp(async dir=>{
  const s=base();s.name='<script>alert(1)</script>';const r=await run(s,dir);
  const html=renderLabReport(r);assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(JSON.parse(await readFile(path.join(dir,'report/report.json'),'utf8')).scenarioHash.length,64);
}));
test('local bridge denies unauthenticated calls, browser origins and malformed operations',async()=>{
  const s=parseScenario(base());const ledger=new SimulatedLedger(s.faults);await ledger.provision(s.fixtures);
  const bridge=await startBridge(ledger,s.fixtures,()=>{},()=>{});
  try {
    assert.equal((await fetch(bridge.url+'/fixtures')).status,403);
    const headers={authorization:`Bearer ${bridge.token}`,'content-type':'application/json'};
    assert.equal((await fetch(bridge.url+'/fixtures',{headers:{...headers,origin:'https://evil.invalid'}})).status,403);
    assert.equal((await fetch(bridge.url+'/execute',{method:'POST',headers,body:JSON.stringify({type:'transferHbar',actor:'alice',to:'bob',amount:-1})})).status,400);
    assert.equal((await fetch(bridge.url+'/fixtures',{headers})).status,200);
  } finally {await bridge.stop();ledger.close();}
});
