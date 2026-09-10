import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runScenario } from '../../dist/lab/runner.js';
import { chromium } from 'playwright';
import { resolveMcpBrowser, playwrightLaunchOptionsForBrowser } from '../../dist/mcpBrowser.js';
const example=path.resolve('examples/lab-ticketing');
async function workspace(fn){const dir=await mkdtemp(path.join(tmpdir(),'lab-browser-'));try{await cp(example,dir,{recursive:true,filter:p=>!p.includes('.harness')});return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function run(dir,name){return runScenario({workspace:dir,file:path.join(dir,'scenarios',name+'.yaml'),outputDirectory:path.join(dir,'reports',name)});}
for(const name of ['purchase','delayed-mirror','wallet-rejection','double-purchase']) test(`ticketing browser: ${name}`,()=>workspace(async dir=>{const r=await run(dir,name);assert.equal(r.infrastructureFailure,false,JSON.stringify(r.events));assert.equal(r.passed,true,JSON.stringify(r.events));assert.equal(r.browserExecuted,true);}));
test('a success toast without a transfer fails the independent ownership assertion',()=>workspace(async dir=>{
 const file=path.join(dir,'ticket-service.mjs');const source=await readFile(file,'utf8');
 await writeFile(file,source.replace("const tx = await execute(purchaseId, { type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });","const tx = { status: 'SUCCESS', transactionId: 'fake' };"));
 const r=await run(dir,'purchase');assert.equal(r.passed,false);assert.equal(r.events.find(e=>e.id==='purchase-ui').status,'passed');assert.equal(r.events.find(e=>e.id==='ownership').status,'failed');
}));
test('mirror-lag regression fails UI despite successful consensus transfer',()=>workspace(async dir=>{
 const file=path.join(dir,'ticket-service.mjs');let source=await readFile(file,'utf8');
 source=source.replace("if (tx.status === 'PENDING') return pending('Purchase');","const indexed = await ledger('/observe', { type: 'nftOwner', token: 'ticket', serial: 1, account: 'customer' });\n    if (!indexed.matches) return { ok: false, message: 'Purchase failed' };");assert.ok(source.includes("if (!indexed.matches)"));await writeFile(file,source);
 const r=await run(dir,'delayed-mirror');assert.equal(r.passed,false);assert.equal(r.events.find(e=>e.id==='purchase-ui').status,'failed');assert.ok(r.events.some(e=>e.kind==='transaction'&&e.evidence?.operation?.type==='transferNft'&&e.evidence.status==='SUCCESS'));
}));
test('portable evidence dashboard renders and filters failures',()=>workspace(async dir=>{
 const r=await run(dir,'purchase');assert.equal(r.passed,true);
 const browser=await chromium.launch(playwrightLaunchOptionsForBrowser(await resolveMcpBrowser(dir)));
 try {const page=await browser.newPage();await page.goto('file://'+path.join(dir,'reports/purchase/index.html'));assert.equal(await page.locator('h1').textContent(),r.name);await page.getByRole('button',{name:'Transaction',exact:true}).click();assert.ok(await page.locator('#timeline details:visible').count()>=3);await page.getByRole('button',{name:'Failed',exact:true}).click();assert.equal(await page.locator('#timeline details:visible').count(),0);}finally{await browser.close();}
}));
test('existing repair loop turns a Lab failure into a second attempt with stable findings',()=>workspace(async dir=>{
 const {runSession}=await import('../../dist/sessionRunner.js');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const exec=promisify(execFile);
 const {mkdir}=await import('node:fs/promises');const {stringify}=await import('yaml');
 const service=path.join(dir,'ticket-service.mjs');const fixed=await readFile(service,'utf8');
 const broken=fixed.replace("const tx = await execute(purchaseId, { type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });","const tx = { status: 'SUCCESS', transactionId: 'fake' };");
 await writeFile(service,broken);await mkdir(path.join(dir,'.harness/validators'),{recursive:true});
 await writeFile(path.join(dir,'agent.mjs'),`import {readFileSync,writeFileSync,existsSync} from 'node:fs';const marker='.harness/runs/called';if(existsSync(marker)){const prompt=process.argv.at(-1);if(!prompt.includes('[lab]'))throw new Error('Lab finding missing from repair prompt');writeFileSync('ticket-service.mjs',${JSON.stringify(fixed)});}writeFileSync(marker,'1');`);
 await writeFile(path.join(dir,'package.json'),'{"name":"lab-loop","version":"1.0.0"}');
 await writeFile(path.join(dir,'.gitignore'),'.harness/runs/\n.harness/runtime/\n');
 await writeFile(path.join(dir,'.harness/prd.md'),'Repair ticket purchase.');
 await writeFile(path.join(dir,'.harness/validators/static.json'),'{}');
 await writeFile(path.join(dir,'.harness/validators/yarn.json'),JSON.stringify({commands:[{name:'install',command:'node --version'}]}));
 await writeFile(path.join(dir,'.harness/spec.yaml'),stringify({schemaVersion:2,name:'lab-loop',generator:{command:'node',args:['agent.mjs','{prompt}']},skills:[],baseline:{commands:[{name:'install',command:'node --version'}]},lab:{scenarios:['scenarios/purchase.yaml']},maxAttempts:2}));
 for(const args of [['init','-q','-b','main'],['config','user.name','Lab Test'],['config','user.email','lab@example.invalid'],['add','.'],['commit','-qm','initial']])await exec('git',args,{cwd:dir});
 const result=await runSession({workspacePath:dir,specPath:path.join(dir,'.harness/spec.yaml')});
 assert.equal(result.report.passed,true);assert.equal(result.report.attempts,2);assert.ok(result.report.fixedFindingIds.some(id=>id.includes('ownership')));assert.equal(result.report.validation.labReports[0].passed,true);
}));
