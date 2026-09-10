/** Prepare an approved grant batch. Signing/execution is delegated to the runner. */
export function preparePayout(batch) {
  if (!batch || typeof batch.batchId !== 'string' || !Array.isArray(batch.directory) || !Array.isArray(batch.grants) || !batch.grants.length)
    throw Error('Invalid grant batch');
  const operations = batch.grants.map((grant) => {
    if (!batch.directory.includes(grant.recipient) || !Number.isFinite(grant.hbar) || grant.hbar <= 0)
      throw Error('Invalid grant');
    return { type: 'transferHbar', actor: 'treasury', to: grant.recipient, amount: grant.hbar };
  });
  operations.push({ type: 'submitMessage', actor: 'treasury', topic: 'audit', message: `grants:${batch.batchId}:count:${batch.grants.length}` });
  return { schemaVersion: 1, operations };
}
