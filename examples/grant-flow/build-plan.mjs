import {readFile,writeFile} from 'node:fs/promises';
import {preparePayout} from './grant-service.mjs';
const batch=JSON.parse(await readFile(new URL('./grants.json',import.meta.url),'utf8'));
await writeFile(new URL('./payout-plan.json',import.meta.url),JSON.stringify(preparePayout(batch),null,2)+'\n');
console.log('Prepared payout-plan.json; no network request or wallet used');
