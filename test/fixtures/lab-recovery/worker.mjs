// A disposable process connected to the test's surviving simulated ledger.
import { randomUUID } from 'node:crypto';
import { TransactionJournal } from '../../../dist/lab/transactions.js';
const [directory,url,phase]=process.argv.slice(2);
const context=await (await fetch(url+'/context')).json();
const post=async(route,body)=>(await fetch(url+route,{method:'POST',body:JSON.stringify(body)})).json();
const crash=()=>process.kill(process.pid,'SIGKILL');
const ledger={
 mode:'simulated',resources:context.resources,
 async execute(operation,beforeSubmit){
  if(phase==='reserved')crash();
  const transactionId='sim-'+randomUUID();await beforeSubmit(transactionId);
  if(phase==='prepared')crash();
  const result=await post('/execute',{transactionId,operation});
  if(phase==='accepted')crash();
  return result;
 },
 async reconcile(transactionId,operation){return post('/receipt',{transactionId,operation});},
};
const journal=new TransactionJournal(ledger,context.fixtures,directory);await journal.start();
const result=await journal.execute('attendance',context.operation,true);
if(phase==='recorded')crash();
await journal.close();console.log(JSON.stringify(result));
