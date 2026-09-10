import test from 'node:test';import assert from 'node:assert/strict';
import {preparePayout} from '../grant-service.mjs';
const batch=()=>({batchId:'unit',directory:['alice','bob'],grants:[{recipient:'alice',hbar:.75},{recipient:'bob',hbar:.25}]});
test('routes a canonical batch to its recipients',()=>{assert.deepEqual(preparePayout(batch()).operations.slice(0,2).map(o=>[o.to,o.amount]),[['alice',.75],['bob',.25]]);});
test('preserves total amount when approval order changes',()=>{const b=batch();b.grants.reverse();assert.equal(preparePayout(b).operations.filter(o=>o.type==='transferHbar').reduce((s,o)=>s+o.amount,0),1);});
test('emits the batch audit record',()=>{assert.deepEqual(preparePayout(batch()).operations.at(-1),{type:'submitMessage',actor:'treasury',topic:'audit',message:'grants:unit:count:2'});});
test('rejects unknown recipients and invalid amounts',()=>{for(const bad of [{recipient:'mallory',hbar:1},{recipient:'alice',hbar:-1},{recipient:'alice',hbar:NaN}]){const b=batch();b.grants=[bad];assert.throws(()=>preparePayout(b));}});
