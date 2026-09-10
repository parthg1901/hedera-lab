import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TransactionJournal } from '../dist/lab/transactions.js';
import { SimulatedLedger } from '../dist/lab/simulated.js';
import { startBridge } from '../dist/lab/bridge.js';
import { createTicketService } from '../examples/lab-ticketing/ticket-service.mjs';
const fixtures = { accounts: { organizer: {hbar:100}, customer:{hbar:10}}, tokens:{ticket:{treasury:'organizer',supply:1}},topics:['attendance'] };
const message = {type:'submitMessage', actor:'customer',topic:'attendance',message:'ticket:1:customer'};
async function setup(fn) {
 const directory=await mkdtemp(path.join(tmpdir(),'lab-transactions-'));
 const faults={mirrorDelayMs:0,rejectActors:[]}; const ledger=new SimulatedLedger(faults);await ledger.provision(fixtures);
 const journal=new TransactionJournal(ledger,fixtures,directory); await journal.start();
 try { await fn({ledger,journal,directory,faults}); } finally {await journal.close();ledger.close();await rm(directory,{recursive:true,force:true});}
}
async function messages(ledger) {return (await ledger.observe({type:'topicMessage',topic:'attendance',message:message.message})).evidence.messages.length;}
function client(journal) {return async (route,input)=>route==='/receipt'?journal.receipt(input.requestId):journal.execute(input.requestId,input.operation,input.retryFailed);}

test('durable receipt resolves lost HCS response after bridge and application restart',()=>setup(async({ledger,journal,directory})=>{
 const execute=ledger.execute.bind(ledger);let lost=false;let writes=0;
 ledger.execute=async(op,before)=>{writes++;const tx=await execute(op,before);if(op.type==='submitMessage'&&!lost){lost=true;throw Error('response lost after consensus');}return tx;};
 let app=createTicketService(client(journal),{recoverable:true});
 assert.equal((await app.handle('buy')).ok,true);
 assert.equal((await app.handle('check-in')).pending,true);
 assert.equal(await messages(ledger),1);
 const saved=JSON.parse(await readFile(path.join(directory,'transactions.json'),'utf8'));
 const pending=saved.state.entries['ticket:1:customer:check-in'].attempts[0];
 assert.ok(pending.transactionId);assert.equal(pending.result,undefined);
 await journal.close();
 const restarted=new TransactionJournal(ledger,fixtures,directory);await restarted.start();
 try {
  app=createTicketService(client(restarted),{recoverable:true});
  const responses=await Promise.all(Array.from({length:8},()=>app.handle('check-in')));
  assert.ok(responses.every(r=>r.ok&&r.transactionId===pending.transactionId));
  assert.equal((await app.handle('buy')).ok,true);
  assert.equal(writes,3);assert.equal(await messages(ledger),1);
 }finally{await restarted.close();}
}));

test('unknown/expired receipts remain pending through restarts and concurrent retries',()=>setup(async({ledger,journal,directory})=>{
 const execute=ledger.execute.bind(ledger);let writes=0;
 ledger.execute=async(op,before)=>{writes++;await execute(op,before);throw Error('offline');};
 ledger.reconcile=async()=>null;
 assert.equal((await journal.execute('check-in',message)).status,'PENDING');
 await journal.close();const restarted=new TransactionJournal(ledger,fixtures,directory);await restarted.start();
 try {
  const results=await Promise.all(Array.from({length:12},()=>restarted.execute('check-in',message,true)));
  assert.ok(results.every(r=>r.status==='PENDING'));assert.equal(writes,1);assert.equal(await messages(ledger),1);
 }finally{await restarted.close();}
}));

test('explicit decline can be retried but completed HCS request cannot execute twice',()=>setup(async({ledger,journal,faults})=>{
 faults.rejectActors.push('customer');
 const first=await journal.execute('check-in',message,true);assert.equal(first.status,'USER_REJECTED');
 faults.rejectActors.length=0;
 assert.equal((await journal.execute('check-in',message)).transactionId,first.transactionId);
 const retry=await journal.execute('check-in',message,true);assert.equal(retry.status,'SUCCESS');assert.notEqual(first.transactionId,retry.transactionId);
 assert.equal((await journal.execute('check-in',message,true)).transactionId,retry.transactionId);assert.equal(await messages(ledger),1);
}));

test('receipt-confirmed purchase recovers despite stale mirror, without NFT resubmission',()=>setup(async({ledger,journal,faults})=>{
 faults.mirrorDelayMs=10000;const execute=ledger.execute.bind(ledger);let transfers=0;
 ledger.execute=async(op,before)=>{const tx=await execute(op,before);if(op.type==='transferNft'){transfers++;throw Error('lost');}return tx;};
 let app=createTicketService(client(journal),{recoverable:true});
 assert.equal((await app.handle('buy')).pending,true);
 assert.equal((await ledger.observe({type:'nftOwner',token:'ticket',serial:1,account:'customer'})).matches,false);
 app=createTicketService(client(journal),{recoverable:true});
 assert.equal((await app.handle('buy')).ok,true);assert.equal(transfers,1);
}));

test('journal is durable before submit and reserves uncertain pre-submit failures',()=>setup(async({ledger,journal,directory})=>{
 let sent=0;
 ledger.execute=async(op,before)=>{
  await before('sim-reserved');
  const disk=JSON.parse(await readFile(path.join(directory,'transactions.json'),'utf8'));
  assert.equal(disk.state.entries.once.attempts[0].transactionId,'sim-reserved');
  throw Error('process failed before sending');
 };
 assert.equal((await journal.execute('once',message)).status,'PENDING');
 ledger.execute=async()=>{sent++;throw Error('must not call');};
 assert.equal((await journal.execute('once',message,true)).status,'PENDING');assert.equal(sent,0);
 assert.equal((await stat(path.join(directory,'transactions.json'))).mode&0o777,0o600);
}));

test('request binding and receipt binding reject changed payloads and unrelated evidence',()=>setup(async({ledger,journal})=>{
 const execute=ledger.execute.bind(ledger);
 ledger.execute=async(op,before)=>{await execute(op,before);throw Error('lost');};
 await journal.execute('once',message);
 await assert.rejects(journal.execute('once',{...message,message:'different'}),/different operation/);
 ledger.reconcile=async()=>({status:'SUCCESS',transactionId:'unrelated',operation:message});
 assert.equal((await journal.receipt('once')).status,'PENDING');
 assert.equal(await journal.receipt('absent'),null);
 for(const key of ['__proto__','constructor','toString','../escape','']) await assert.rejects(journal.receipt(key),/Invalid request ID/);
}));

test('journal write failure stops submissions and poisons the process',()=>setup(async({ledger,journal,directory})=>{
 let sent=0;ledger.execute=async()=>{sent++;throw Error('must not send');};
 await rm(path.join(directory,'transactions.json.tmp'),{force:true});
 const {mkdir}=await import('node:fs/promises');await mkdir(path.join(directory,'transactions.json.tmp'));
 await assert.rejects(journal.execute('once',message));await assert.rejects(journal.execute('again',message),/Journal write failed/);assert.equal(sent,0);
}));

test('second writer, corrupt journal and wrong fixture scope fail closed',()=>setup(async({ledger,journal,directory})=>{
 await assert.rejects(new TransactionJournal(ledger,fixtures,directory).start(),/already owned|EEXIST/);
 await journal.execute('once',message);await journal.close();
 ledger.resources.topics.attendance='0.0.9999';
 await assert.rejects(new TransactionJournal(ledger,fixtures,directory).start(),/scope mismatch/);
 await writeFile(path.join(directory,'transactions.json'),'{broken');
 await assert.rejects(new TransactionJournal(ledger,fixtures,directory).start(),SyntaxError);
}));

test('HTTP bridge supports durable recovery with authenticated, operation-bound request IDs',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'lab-recovery-http-'));const ledger=new SimulatedLedger({mirrorDelayMs:0,rejectActors:[]});await ledger.provision(fixtures);
 let bridge=await startBridge(ledger,fixtures,()=>{},()=>{},directory);
 const request=async(route,body)=>{
  const response=await fetch(bridge.url+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
 };
 try {
  assert.deepEqual((await request('/capabilities')).body,{durableReceipts:true});
  const first=await request('/execute-once',{requestId:'once',operation:message});assert.equal(first.body.status,'SUCCESS');
  await bridge.stop();bridge=await startBridge(ledger,fixtures,()=>{},()=>{},directory);
  const recovered=await request('/receipt',{requestId:'once'});assert.equal(recovered.body.transactionId,first.body.transactionId);
  assert.equal((await request('/execute-once',{requestId:'once',operation:{...message,message:'wrong'}})).status,400);
  assert.equal((await fetch(bridge.url+'/receipt',{method:'POST',body:'{}'})).status,403);
  assert.equal(await messages(ledger),1);
 }finally{await bridge.stop();ledger.close();await rm(directory,{recursive:true,force:true});}
});

for(const phase of ['reserved','prepared','accepted','recorded']) test(`SIGKILL recovery: ${phase} crash never creates another HCS message`,{skip:process.platform!=='linux'&&'Automatic SIGKILL ownership recovery requires Linux flock'},async()=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');
 const directory=await mkdtemp(path.join(tmpdir(),'lab-crash-'));
 const ledger=new SimulatedLedger({mirrorDelayMs:0,rejectActors:[]});await ledger.provision(fixtures);const receipts=new Map();let writes=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/context'){res.end(JSON.stringify({fixtures,resources:ledger.resources,operation:message}));return;}
  let body='';for await(const c of req)body+=c;const input=JSON.parse(body);
  if(req.url==='/execute'){writes++;const tx=await ledger.execute(input.operation);const result={...tx,transactionId:input.transactionId};receipts.set(input.transactionId,result);res.end(JSON.stringify(result));}
  else res.end(JSON.stringify(receipts.get(input.transactionId)??null));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 const run=mode=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['test/fixtures/lab-recovery/worker.mjs',directory,url,mode],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal,stdout,stderr,pid:child.pid}));
 });
 try{
  const killed=await run(phase);assert.equal(killed.signal,'SIGKILL',killed.stderr);
  // No lock deletion or PID-based takeover: the kernel releases ownership.
  const owner=JSON.parse(await readFile(path.join(directory,'owner.lock'),'utf8'));
  assert.equal(owner.pid,killed.pid);
  assert.equal(owner.protocol,'linux-flock-v1');
  const restarted=await run('recover');assert.equal(restarted.code,0,restarted.stderr);
  const result=JSON.parse(restarted.stdout);
  const committed=['accepted','recorded'].includes(phase);
  assert.equal(result.status,committed?'SUCCESS':'PENDING');assert.equal(writes,committed?1:0);assert.equal(await messages(ledger),committed?1:0);
  const again=await run('recover');assert.equal(again.code,0,again.stderr);assert.equal(JSON.parse(again.stdout).status,result.status);assert.equal(writes,committed?1:0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));ledger.close();await rm(directory,{recursive:true,force:true});}
});

test('an unopened journal cannot submit and a fresh simulator cannot reuse old receipts',()=>setup(async({ledger,journal,directory})=>{
 const unopened=new TransactionJournal(ledger,fixtures,directory);
 await assert.rejects(unopened.execute('once',message),/must be started/);
 await journal.execute('once',message);await journal.close();
 const fresh=new SimulatedLedger({mirrorDelayMs:0,rejectActors:[]});await fresh.provision(fixtures);
 assert.deepEqual(fresh.resources,ledger.resources);
 try{await assert.rejects(new TransactionJournal(fresh,fixtures,directory).start(),/scope mismatch/);assert.equal(await messages(fresh),0);}finally{fresh.close();}
}));
