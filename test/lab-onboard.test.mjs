import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectApplication,initializeOnboarding,approveOnboarding,checkOnboarding,parseExpectations} from '../dist/lab/onboard.js';
const config=()=>({schemaVersion:1,entry:'app.mjs',exportName:'pay',input:'input.json',format:'transfers',actor:'treasury',expected:{alice:0.75,bob:0.25}});
const good=`export function pay(input){return input.map(x=>({recipient:x.name,amount:x.value}));}`;
async function fixture(fn){const root=await mkdtemp(path.join(os.tmpdir(),'lab-onboard-'));try{await writeFile(path.join(root,'app.mjs'),good);await writeFile(path.join(root,'input.json'),JSON.stringify([{name:'bob',value:0.25},{name:'alice',value:0.75}]));await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('inspection never executes code and excludes hidden, dependencies and symlinks',()=>fixture(async root=>{
 await writeFile(path.join(root,'trap.mjs'),`throw Error('must not run'); export function transfer(){}`);
 await mkdir(path.join(root,'node_modules'));await writeFile(path.join(root,'node_modules/hidden.mjs'),'export function hidden(){}');
 await writeFile(path.join(root,'.env'),'secret');await symlink('app.mjs',path.join(root,'linked.mjs'));
 const result=await inspectApplication(root);assert.deepEqual(result.candidates.map(c=>c.file),['app.mjs','trap.mjs']);assert.deepEqual(result.inputs,['input.json']);
}));
test('initialization calls real business logic, generates independent checks and provider handoff',()=>fixture(async root=>{
 const report=await initializeOnboarding(root,config(),true);assert.equal(report.passed,true);assert.equal(report.mode,'simulated');
 const plan=JSON.parse(await readFile(path.join(root,'verification/payout-plan.json')));assert.equal(plan.operations[0].to,'bob');
 const handoff=JSON.parse(await readFile(path.join(root,'verification/provider-handoff.json')));assert.equal(handoff.status,'requires-provider-registration');assert.equal(handoff.priceTinybar,undefined);
 assert.match(await readFile(path.join(root,'verification/CONTRACT.md'),'utf8'),/alice must receive exactly 0.75/);
 await assert.rejects(initializeOnboarding(root,config(),true),/EEXIST/);
}));
test('wrong recipient amounts fail independent assertions; source repair preserves reviewed contract',()=>fixture(async root=>{
 await writeFile(path.join(root,'app.mjs'),`export function pay(input){return input.map(x=>({recipient:x.name,amount:0.5}));}`);
 const before=await initializeOnboarding(root,config(),true);assert.equal(before.passed,false);
 assert.equal(before.events.find(e=>e.status==='failed').id,'approved-1');
 await approveOnboarding(root);
 const contract=await readFile(path.join(root,'verification/CONTRACT.md'),'utf8');
 await writeFile(path.join(root,'app.mjs'),good);
 const after=await checkOnboarding(root,true);assert.equal(after.passed,true);
 assert.equal(await readFile(path.join(root,'verification/CONTRACT.md'),'utf8'),contract);
}));
test('approved contract mutation blocks before any application execution',()=>fixture(async root=>{
 await initializeOnboarding(root,config(),true);await approveOnboarding(root);
 await writeFile(path.join(root,'verification/CONTRACT.md'),'weakened');
 await writeFile(path.join(root,'app.mjs'),`throw Error('should not execute')`);
 await assert.rejects(checkOnboarding(root,true),/Reviewed contract changed/);
}));
test('checks require review and explicit local execution consent',()=>fixture(async root=>{
 await assert.rejects(initializeOnboarding(root,config(),false),/allow-execution/);
 await initializeOnboarding(root,config(),true);
 await assert.rejects(checkOnboarding(root,false),/allow-execution/);
 await assert.rejects(checkOnboarding(root,true),/ENOENT/);
}));
test('adapter does not inherit wallet secrets or NODE_OPTIONS',()=>fixture(async root=>{
 const old=process.env.HEDERA_OPERATOR_KEY;
 process.env.HEDERA_OPERATOR_KEY='do-not-inherit';
 try{
 await writeFile(path.join(root,'app.mjs'),`if(process.env.HEDERA_OPERATOR_KEY||process.env.NODE_OPTIONS)throw Error('secret inherited');${good}`);
 assert.equal((await initializeOnboarding(root,config(),true)).passed,true);
 }finally{if(old===undefined)delete process.env.HEDERA_OPERATOR_KEY;else process.env.HEDERA_OPERATOR_KEY=old;}
}));
test('traversal, symlink, non-JS entry and empty requirements rejected',()=>fixture(async root=>{
 await symlink('app.mjs',path.join(root,'linked.mjs'));
 for(const entry of ['../outside.mjs','linked.mjs'])await assert.rejects(initializeOnboarding(root,{...config(),entry},true),/traversal|Symlink/);
 await writeFile(path.join(root,'app.ts'),good);
 await assert.rejects(initializeOnboarding(root,{...config(),entry:'app.ts'},true),/Compile/);
 await assert.rejects(initializeOnboarding(root,{...config(),expected:{}},true),/required/);
}));
test('unknown recipients and unsupported output cannot become a passing package',()=>fixture(async root=>{
 await writeFile(path.join(root,'app.mjs'),`export function pay(){return [{recipient:'mallory',amount:1}]}`);
 await assert.rejects(initializeOnboarding(root,config(),true),/Unknown to/);
}));
test('additional operation on rerun cannot escape protected scenario coverage',()=>fixture(async root=>{
 await initializeOnboarding(root,config(),true);await approveOnboarding(root);
 const before=await readFile(path.join(root,'verification/payout-plan.json'),'utf8');
 await writeFile(path.join(root,'app.mjs'),`export function pay(input){return [...input.map(x=>({recipient:x.name,amount:x.value})),{recipient:'bob',amount:0.1}];}`);
 await assert.rejects(checkOnboarding(root,true),/Every application plan operation/);
 assert.equal(await readFile(path.join(root,'verification/payout-plan.json'),'utf8'),before);
}));
test('requirements reject duplicates, precision loss and reserved fixture names',()=>{
 for(const text of ['alice=0','alice=-1','alice=0.000000001','alice=1,alice=2','treasury=1','constructor=1','alice=NaN','alice=1=2'])assert.throws(()=>parseExpectations(text,'treasury'));
 assert.deepEqual(parseExpectations('alice=0.75,bob=0.25','treasury'),{alice:0.75,bob:0.25});
});
test('noninteractive CLI completes inspect/init/approve/check without handwritten Lab files',()=>fixture(async root=>{
 const cli=path.resolve('dist/index.js');
 const run=(...args)=>spawnSync(process.execPath,[cli,'lab','onboard',...args,'--workspace',root],{encoding:'utf8'});
 assert.equal(run('inspect').status,0);
 const init=run('init','--entry','app.mjs','--export','pay','--input','input.json','--expect','alice=0.75,bob=0.25','--allow-execution');
 assert.equal(init.status,0,init.stderr);assert.match(init.stdout,/PASS/);
 assert.equal(run('approve').status,0);
 const check=run('check','--allow-execution');assert.equal(check.status,0,check.stderr);
}));
test('one-tinybar approvals survive JSON numeric notation without rounding away intent',()=>fixture(async root=>{
 await writeFile(path.join(root,'input.json'),JSON.stringify([{name:'alice',value:0.00000001}]));
 const report=await initializeOnboarding(root,{...config(),expected:{alice:0.00000001}},true);
 assert.equal(report.passed,true);
}));
test('native payout-plan output is supported without inferring expected balances',()=>fixture(async root=>{
 await writeFile(path.join(root,'app.mjs'),`export function pay(input){return {schemaVersion:1,operations:input.map(x=>({type:'transferHbar',actor:'treasury',to:x.name,amount:x.value}))}}`);
 assert.equal((await initializeOnboarding(root,{...config(),format:'plan'},true)).passed,true);
}));
test('a build that rewrites protected assertions is rejected before simulation',()=>fixture(async root=>{
 await initializeOnboarding(root,config(),true);await approveOnboarding(root);
 await writeFile(path.join(root,'app.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync('verification/scenarios/simulated.yaml','tampered');${good}`);
 await assert.rejects(checkOnboarding(root,true),/changed protected/);
}));
