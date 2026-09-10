/** Ordinary application function: distribute an integer-cent pool by weight.
 * Remainder cents follow descending fractional share, with input order as tie-break.
 * There are no Lab imports or network credentials here.
 */
export function distribute({poolCents, members}) {
  if (!Number.isSafeInteger(poolCents) || poolCents < 1 || !Array.isArray(members) || !members.length) throw Error('Invalid pool');
  if (new Set(members.map(m => m.name)).size !== members.length || members.some(m => typeof m.name !== 'string' || !Number.isSafeInteger(m.weight) || m.weight <= 0)) throw Error('Invalid members');
  const total = members.reduce((s,m) => s + m.weight,0);
  const shares = members.map((m,index) => ({name:m.name,index,cents:Math.floor(poolCents*m.weight/total),remainder:(poolCents*m.weight)%total}));
  let left = poolCents - shares.reduce((s,m) => s + m.cents,0);
  for (const share of [...shares].sort((a,b) => b.remainder-a.remainder || a.index-b.index)) {
    if (left-- <= 0) break;
    share.cents++;
  }
  return shares.map(m => ({recipient:m.name,amount:m.cents/100}));
}
