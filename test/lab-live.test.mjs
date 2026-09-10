import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as sdk from '@hiero-ledger/sdk';
import { LiveLedger } from '../dist/lab/live.js';
import { LabInfrastructureError } from '../dist/lab/types.js';
const fixtures={accounts:{alice:{hbar:10},bob:{hbar:5}},tokens:{ticket:{treasury:'alice',supply:1}},topics:['wall']};
// Real SDK transaction construction/signing; execute is stubbed. This is not a live-network test.
test('SDK adapter provisions, constructs signed operations, reads mirror evidence and cleans up',async()=>{
 const original=sdk.Transaction.prototype.execute;
 const env={id:process.env.LAB_SDK_TEST_ID,key:process.env.LAB_SDK_TEST_KEY};
 process.env.LAB_SDK_TEST_ID='0.0.2';process.env.LAB_SDK_TEST_KEY=sdk.PrivateKey.generateECDSA().toStringRaw();
 let next=100;const transactions=[];let failTransfer=false;let unhealthy=false;
 sdk.Transaction.prototype.execute=async function(){transactions.push(this);if(failTransfer&&this instanceof sdk.TransferTransaction)throw {status:sdk.Status.TokenNotAssociatedToAccount};let receipt={status:sdk.Status.Success};if(this instanceof sdk.AccountCreateTransaction)receipt.accountId=sdk.AccountId.fromString(`0.0.${next++}`);if(this instanceof sdk.TokenCreateTransaction)receipt.tokenId=sdk.TokenId.fromString('0.0.200');if(this instanceof sdk.TopicCreateTransaction)receipt.topicId=sdk.TopicId.fromString('0.0.300');return {getReceiptQuery:()=>({setMaxAttempts(){return this;},setMaxBackoff(){return this;},execute:async()=>receipt})};};
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(unhealthy){res.writeHead(503).end('{}');return;}if(req.url.includes('/nfts/'))res.end(JSON.stringify({account_id:'0.0.101'}));else if(req.url.includes('/messages'))res.end(JSON.stringify({messages:[{message:Buffer.from('hello').toString('base64'),consensus_timestamp:'1.2'}],links:{next:null}}));else res.end('{"nodes":[]}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ledger=new LiveLedger({mode:'local',nodeAddress:'127.0.0.1:50211',nodeAccountId:'0.0.3',mirrorUrl:`http://127.0.0.1:${server.address().port}`,operatorIdEnv:'LAB_SDK_TEST_ID',operatorKeyEnv:'LAB_SDK_TEST_KEY'});
 try{
  await ledger.provision(fixtures);assert.deepEqual(ledger.resources,{accounts:{alice:'0.0.100',bob:'0.0.101'},tokens:{ticket:'0.0.200'},topics:{wall:'0.0.300'}});
  for(const operation of [{type:'associate',actor:'bob',token:'ticket'},{type:'transferNft',actor:'alice',to:'bob',token:'ticket',serial:1},{type:'submitMessage',actor:'bob',topic:'wall',message:'hello'},{type:'transferHbar',actor:'alice',to:'bob',amount:1}]){
   const tx=await ledger.execute(operation);assert.equal(tx.status,'SUCCESS');assert.ok(tx.transactionId.startsWith(ledger.resources.accounts[operation.actor]+'@'));
  }
  assert.equal((await ledger.observe({type:'nftOwner',token:'ticket',serial:1,account:'bob'})).matches,true);
  assert.equal((await ledger.observe({type:'topicMessage',topic:'wall',message:'hello'})).matches,true);
  failTransfer=true;assert.equal((await ledger.execute({type:'transferNft',actor:'alice',to:'bob',token:'ticket',serial:1})).status,'TOKEN_NOT_ASSOCIATED_TO_ACCOUNT');
  unhealthy=true;await assert.rejects(ledger.observe({type:'nftOwner',token:'ticket',serial:1,account:'bob'}),LabInfrastructureError);
  assert.deepEqual(await ledger.cleanup(),[]);
  assert.equal(transactions.filter(t=>t instanceof sdk.AccountDeleteTransaction).length,2);
  const dissociations=transactions.filter(t=>t instanceof sdk.TokenDissociateTransaction);
  assert.equal(dissociations.length,2);
  assert.ok(transactions.indexOf(dissociations[1]) < transactions.findIndex(t=>t instanceof sdk.AccountDeleteTransaction));
  assert.equal(transactions.filter(t=>t instanceof sdk.TokenDeleteTransaction).length,1);
  assert.equal(transactions.filter(t=>t instanceof sdk.TopicDeleteTransaction).length,1);
 }finally{ledger.close();sdk.Transaction.prototype.execute=original;for(const [name,value]of [['LAB_SDK_TEST_ID',env.id],['LAB_SDK_TEST_KEY',env.key]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('receipt polling overrides submission retry budget without invoking resubmission helper',async()=>{
 const {awaitReceipt}=await import('../dist/lab/receipt.js');
 const calls=[];const receipt={status:sdk.Status.Success};const client={};
 const query={setMaxAttempts(n){calls.push(['attempts',n]);return this;},setMaxBackoff(n){calls.push(['backoff',n]);return this;},async execute(c){assert.equal(c,client);return receipt;}};
 const response={getReceipt(){throw new Error('Unsafe resubmission helper called');},getReceiptQuery(c){assert.equal(c,client);return query;}};
 assert.equal(await awaitReceipt(response,client),receipt);assert.deepEqual(calls,[['attempts',30],['backoff',1000]]);
});
test('uncertain account creation keeps a private recovery journal and resolves before cleanup',async()=>{
 const {mkdtemp,readFile,stat,rm,access}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const directory=await mkdtemp(path.join(tmpdir(),'lab-recovery-'));
 const ledger=new LiveLedger({mode:'testnet'},directory);
 const key=sdk.PrivateKey.generateECDSA();ledger.sdk=sdk;ledger.client=sdk.Client.forTestnet().setOperator('0.0.2',key);ledger.operatorId='0.0.2';ledger.operatorKey=key;
 ledger.keys.set('alice',sdk.PrivateKey.generateECDSA());ledger.creationContext={kind:'accounts',name:'alice'};
 const original=sdk.Transaction.prototype.execute;const originalQuery=sdk.TransactionReceiptQuery.prototype.execute;
 let createdId;let throwReceipt=true;let failCleanup=false;
 sdk.Transaction.prototype.execute=async function(){
  if(this instanceof sdk.AccountCreateTransaction){createdId=this.transactionId.toString();return {getReceiptQuery:()=>({setMaxAttempts(){return this;},setMaxBackoff(){return this;},async execute(){if(throwReceipt)throw new Error('receipt temporarily unavailable');return {status:sdk.Status.Success,accountId:sdk.AccountId.fromString('0.0.999')};}})};}
  if(failCleanup)throw new Error('offline');
  return {getReceiptQuery:()=>({setMaxAttempts(){return this;},setMaxBackoff(){return this;},async execute(){return {status:sdk.Status.Success};}})};
 };
 sdk.TransactionReceiptQuery.prototype.execute=async function(){assert.equal(this.transactionId.toString(),createdId);return {status:sdk.Status.Success,accountId:sdk.AccountId.fromString('0.0.999')};};
 try{
  await assert.rejects(ledger.transact(new sdk.AccountCreateTransaction().setECDSAKeyWithAlias(ledger.keys.get('alice')).setInitialBalance(new sdk.Hbar(5))));
  const file=path.join(directory,'lab-recovery.json');const j=JSON.parse(await readFile(file,'utf8'));
  assert.equal(j.pendingCreations.length,1);assert.equal(j.pendingCreations[0].transactionId,createdId);assert.ok(j.accounts.alice.privateKey);
  const nextLedger=new LiveLedger({mode:"testnet"},directory);
  await assert.rejects(nextLedger.provision(fixtures),/Unfinished recovery journal/);
  assert.equal(await readFile(file,"utf8"),JSON.stringify(j));
  assert.equal((await stat(file)).mode&0o777,0o600);assert.ok(!JSON.stringify(j).includes(key.toStringRaw()));
  failCleanup=true;assert.equal((await ledger.cleanup()).length,1);await access(file);
  failCleanup=false;throwReceipt=false;assert.deepEqual(await ledger.cleanup(),[]);await assert.rejects(access(file));assert.equal(ledger.resources.accounts.alice,'0.0.999');
 }finally{sdk.Transaction.prototype.execute=original;sdk.TransactionReceiptQuery.prototype.execute=originalQuery;ledger.close();await rm(directory,{recursive:true,force:true});}
});

test('recoverable SDK writes persist original ID before sending and disable write retries',async()=>{
 const ledger=new LiveLedger({mode:'testnet'});const key=sdk.PrivateKey.generateECDSA();
 ledger.sdk=sdk;ledger.resources.accounts.alice='0.0.100';ledger.resources.topics.wall='0.0.300';ledger.keys.set('alice',key);
 const original=sdk.Transaction.prototype.execute;let persisted;let sent=0;let settings;
 sdk.Transaction.prototype.execute=async function(){sent++;settings={id:this.transactionId.toString(),maxAttempts:this.maxAttempts,regenerate:this.regenerateTransactionId};throw Error('response lost');};
 try {
  await assert.rejects(ledger.execute({type:'submitMessage',actor:'alice',topic:'wall',message:'hello'},async id=>{persisted=id;}),/outcome unavailable/);assert.equal(sent,1);assert.deepEqual(settings,{id:persisted,maxAttempts:1,regenerate:false});assert.ok(persisted.startsWith('0.0.100@'));
  await assert.rejects(ledger.execute({type:'submitMessage',actor:'alice',topic:'wall',message:'hello'},async()=>{throw Error('disk full');}));assert.equal(sent,1);
 }finally{sdk.Transaction.prototype.execute=original;ledger.close();}
});

test('SDK reconciliation uses original receipt then bound mirror archive, never submits',async()=>{
 const ledger=new LiveLedger({mode:'local',mirrorUrl:'unused'});ledger.sdk=sdk;ledger.resources.accounts.alice='0.0.100';
 const operation={type:'submitMessage',actor:'alice',topic:'wall',message:'hello'};
 const id='0.0.100@1788700000.123456789';const mirrorId='0.0.100-1788700000-123456789';
 const original=sdk.TransactionReceiptQuery.prototype.execute;const originalWrite=sdk.Transaction.prototype.execute;
 let receiptStatus=sdk.Status.Success;let requests=0;let rows=[];
 const server=createServer((req,res)=>{requests++;assert.equal(req.url,`/api/v1/transactions/${mirrorId}?nonce=0&scheduled=false`);res.setHeader('content-type','application/json');res.end(JSON.stringify({transactions:rows}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));ledger.mirror=`http://127.0.0.1:${server.address().port}`;
 sdk.Transaction.prototype.execute=async()=>{throw Error('Recovery must never submit');};
 sdk.TransactionReceiptQuery.prototype.execute=async function(){assert.equal(this.transactionId.toString(),id);assert.equal(this.validateStatus,false);if(receiptStatus===null)throw Error('receipt expired');return {status:receiptStatus};};
 try {
  assert.equal((await ledger.reconcile(id,operation)).status,'SUCCESS');assert.equal(requests,0);
  receiptStatus=sdk.Status.TokenNotAssociatedToAccount;assert.equal((await ledger.reconcile(id,operation)).status,'TOKEN_NOT_ASSOCIATED_TO_ACCOUNT');
  receiptStatus=null;assert.equal(await ledger.reconcile(id,operation),null);
  const valid={transaction_id:mirrorId,nonce:0,scheduled:false,name:'CONSENSUSSUBMITMESSAGE',result:'SUCCESS',consensus_timestamp:'1788700001.1'};
  rows=[valid];assert.equal((await ledger.reconcile(id,operation)).status,'SUCCESS');
  for(const change of [{transaction_id:'wrong'},{nonce:1},{scheduled:true},{name:'CRYPTOTRANSFER'},{result:'DUPLICATE_TRANSACTION'},{result:'UNKNOWN'}]) {rows=[{...valid,...change}];assert.equal(await ledger.reconcile(id,operation),null);}
  rows=[valid,{...valid,result:'DUPLICATE_TRANSACTION'}];assert.equal((await ledger.reconcile(id,operation)).status,'SUCCESS');
  rows=[valid,valid];assert.equal(await ledger.reconcile(id,operation),null);
  const before=requests;assert.equal(await ledger.reconcile('0.0.999@1788700000.123456789',operation),null);assert.equal(requests,before);
 }finally{sdk.TransactionReceiptQuery.prototype.execute=original;sdk.Transaction.prototype.execute=originalWrite;ledger.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('SDK resume restores original fixture IDs and signer keys without reprovisioning',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const directory=await mkdtemp(path.join(tmpdir(),'lab-resume-'));
 const previous={id:process.env.LAB_RESUME_ID,key:process.env.LAB_RESUME_KEY};
 const operator=sdk.PrivateKey.generateECDSA(),alice=sdk.PrivateKey.generateECDSA(),bob=sdk.PrivateKey.generateECDSA();
 process.env.LAB_RESUME_ID='0.0.2';process.env.LAB_RESUME_KEY=operator.toStringRaw();
 const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{"nodes":[]}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const config={mode:'local',nodeAddress:'127.0.0.1:50211',nodeAccountId:'0.0.3',mirrorUrl:`http://127.0.0.1:${server.address().port}`,operatorIdEnv:'LAB_RESUME_ID',operatorKeyEnv:'LAB_RESUME_KEY'};
 const saved={schemaVersion:1,network:config,operatorId:'0.0.2',pendingCreations:[],resources:{accounts:{alice:'0.0.100',bob:'0.0.101'},tokens:{ticket:'0.0.200'},topics:{wall:'0.0.300'}},accounts:{alice:{privateKey:alice.toStringRaw()},bob:{privateKey:bob.toStringRaw()}}};
 await writeFile(path.join(directory,'lab-recovery.json'),JSON.stringify(saved),{mode:0o600});
 const ledger=new LiveLedger(config,directory);const original=sdk.Transaction.prototype.execute;let submits=0;
 sdk.Transaction.prototype.execute=async()=>{submits++;throw Error('must not submit');};
 try{
  await ledger.resume(fixtures);assert.equal(submits,0);assert.deepEqual(ledger.resources,saved.resources);assert.equal(ledger.keys.get('alice').toStringRaw(),alice.toStringRaw());
  const mismatch=new LiveLedger({...config,nodeAccountId:'0.0.4'},directory);await assert.rejects(mismatch.resume(fixtures),/mismatch/);mismatch.close();
  await writeFile(path.join(directory,'lab-recovery.json'),JSON.stringify({...saved,pendingCreations:[{transactionId:'uncertain'}]}));
  const incomplete=new LiveLedger(config,directory);await assert.rejects(incomplete.resume(fixtures),/unfinished fixture/);incomplete.close();assert.equal(submits,0);
 }finally{ledger.close();sdk.Transaction.prototype.execute=original;for(const [name,value]of [['LAB_RESUME_ID',previous.id],['LAB_RESUME_KEY',previous.key]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

test('metered SDK writes carry fee limits and cannot spend cleanup reserve on business operations', async()=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const dir=await mkdtemp(path.join(os.tmpdir(),'metered-sdk-'));
 const terms={perTransactionMaxTinybar:'1000000',feeCeilingTinybar:'2000000',cleanupReserveTinybar:'1000000'};
 const ledger=new LiveLedger({mode:'local',nodeAddress:'127.0.0.1:50211',nodeAccountId:'0.0.3',mirrorUrl:'unused'},dir,terms);
 ledger.sdk=sdk;ledger.resources.accounts.alice='0.0.100';ledger.resources.topics.wall='0.0.200';ledger.keys.set('alice',sdk.PrivateKey.generateECDSA());
 const original=sdk.Transaction.prototype.execute;let sends=0;
 sdk.Transaction.prototype.execute=async function(){
  sends++;assert.equal(this.maxTransactionFee.toTinybars().toString(),'1000000');assert.equal(this.maxAttempts,1);assert.equal(this.regenerateTransactionId,false);
  const journal=JSON.parse(await readFile(path.join(dir,'funding-journal.json')));assert.equal(journal.records.at(-1).transactionId,this.transactionId.toString());
  return {getReceiptQuery:()=>({setMaxAttempts(){return this;},setMaxBackoff(){return this;},execute:async()=>({status:sdk.Status.Success})})};
 };
 try{
  await ledger.execute({type:'submitMessage',actor:'alice',topic:'wall',message:'bounded'});
  await assert.rejects(ledger.execute({type:'submitMessage',actor:'alice',topic:'wall',message:'over-budget'}));assert.equal(sends,1);
 }finally{sdk.Transaction.prototype.execute=original;ledger.close();await rm(dir,{recursive:true,force:true});}
});
