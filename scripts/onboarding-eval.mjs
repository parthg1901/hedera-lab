/** Reproduce onboarding without touching a provider, wallet or live network. */
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const exec=promisify(execFile);
const cli=path.resolve('dist/index.js');
const source=path.resolve('examples/team-payouts');
const output=path.resolve(process.argv[2]??'.harness/runs/onboarding-evaluation');
const root=await mkdtemp(path.join(os.tmpdir(),'hedera-onboarding-eval-'));
const hash=s=>createHash('sha256').update(s).digest('hex');
async function run(args,code=0){
 const start=performance.now();let result;
 try{result=await exec(process.execPath,[cli,'lab','onboard',...args,'--workspace',root],{timeout:30000});assert.equal(code,0,'Expected failed verification');}
 catch(e){assert.equal(e.code,code,e.stderr??e.message);result=e;}
 return {stdout:result.stdout.replaceAll(root,'<workspace>'),durationMs:Math.round(performance.now()-start),exitCode:code};
}
async function report(){const last=JSON.parse(await readFile(path.join(root,'verification/last-run.json')));return JSON.parse(await readFile(path.join(root,path.dirname(last.report),'report.json')));}
try{
 await cp(source,root,{recursive:true});await mkdir(output,{recursive:true});
 const sourceBefore=hash(await readFile(path.join(root,'payouts.mjs')));
 const discovery=await run(['inspect']);
 const initial=await run(['init','--entry','payouts.mjs','--export','distribute','--input','batch.json','--expect','designer=0.34,engineer=0.67','--allow-execution']);
 const initialReport=await report();assert.equal(initialReport.passed,true);
 await run(['approve']);
 const original=await readFile(path.join(root,'batch.json'),'utf8');
 const different=JSON.parse(original);different.poolCents=100;
 await writeFile(path.join(root,'batch.json'),JSON.stringify(different));
 const mismatch=await run(['check','--allow-execution'],1);
 const mismatchReport=await report();assert.equal(mismatchReport.passed,false);
 await writeFile(path.join(root,'batch.json'),original);
 const rerun=await run(['check','--allow-execution']);
 const rerunReport=await report();assert.equal(rerunReport.passed,true);
 assert.equal(hash(await readFile(path.join(root,'payouts.mjs'))),sourceBefore);
 const summary={date:new Date().toISOString(),application:'team-payouts',applicationOrigin:'New synthetic onboarding fixture; not an independently sourced unfamiliar repository',mode:'simulated',walletUsed:false,paymentMade:false,providerDeployed:false,handwrittenLabFiles:0,applicationSourceModified:false,independentlySpecifiedRequirements:'designer receives 0.34 HBAR; engineer receives 0.67 HBAR',interactiveWalkthrough:{performedSeparately:true,defaultAnswers:5,requirementAnswers:1,executionConsentAnswers:1},discovery,initial,mismatch,rerun,negativeControl:'Changed the supplied pool input from 101 to 100 cents while retaining approved amounts; no defect injected into application source',limits:['HBAR payout shapes only','No automatic semantic adapter synthesis','No independent unfamiliar-repository or human usability study','Provider registration remains manual','No new live-network evidence']};
 for(const [file,value] of Object.entries({'summary.json':summary,'initial-report.json':initialReport,'input-mismatch-report.json':mismatchReport,'rerun-report.json':rerunReport}))await writeFile(path.join(output,file),JSON.stringify(value,null,2)+'\n');
 const last=JSON.parse(await readFile(path.join(root,'verification/last-run.json')));
 await cp(path.join(root,last.report),path.join(output,'report.html'));
 console.log(JSON.stringify({passed:true,output,handwrittenLabFiles:0,initialMs:initial.durationMs,mismatchDetected:true,rerunMs:rerun.durationMs},null,2));
}finally{await rm(root,{recursive:true,force:true});}
