/** App behavior under test. Lab supplies a server-side transaction adapter. */
export function createTicketService(ledger, { recoverable = false } = {}) {
  if (recoverable) return createRecoverableTicketService(ledger);
  let purchased = false;
  let checkedIn = false;
  let checkInUncertain = false;
  let purchaseUncertain = false;
  let queue = Promise.resolve();
  const execute = async op => {
    const tx = await ledger('/execute', op);
    return tx;
  };
  const buy = async () => {
    if (purchased) return { ok: true, message: 'Ticket purchased' };
    if (purchaseUncertain) {
      const ownership = await ledger('/observe', { type: 'nftOwner', token: 'ticket', serial: 1, account: 'customer' });
      if (!ownership.matches) return { ok: false, message: 'Purchase outcome pending; retry verification' };
      purchased = true;
      purchaseUncertain = false;
      return { ok: true, message: 'Ticket purchased' };
    }
    const association = await execute({ type: 'associate', actor: 'customer', token: 'ticket' });
    if (!['SUCCESS', 'TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT'].includes(association.status)) return failure(association.status);
    purchaseUncertain = true;
    const transfer = await execute({ type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });
    purchaseUncertain = false;
    if (transfer.status !== 'SUCCESS') return failure(transfer.status);
    purchased = true;
    // Consensus success is authoritative; a lagging mirror must not undo it.
    return { ok: true, message: 'Ticket purchased', transactionId: transfer.transactionId };
  };
  const checkIn = async () => {
    if (!purchased) return { ok: false, message: 'Buy a ticket first' };
    if (checkedIn) return { ok: true, message: 'Checked in' };
    // Legacy adapters do not expose receipt recovery. Do not create a second
    // message merely because the first successful response was lost.
    if (checkInUncertain) return { ok: false, message: 'Check-in outcome pending; receipt reconciliation required' };
    checkInUncertain = true;
    const tx = await execute({ type: 'submitMessage', actor: 'customer', topic: 'attendance', message: 'ticket:1:customer' });
    checkInUncertain = false;
    if (tx.status !== 'SUCCESS') return failure(tx.status);
    checkedIn = true;
    return { ok: true, message: 'Checked in', transactionId: tx.transactionId };
  };
  return {
    handle(action) {
      const next = queue.then(() => action === 'buy' ? buy() : action === 'check-in' ? checkIn() : { ok: false, message: 'Unknown action' });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
function failure(status) { return { ok: false, message: status === 'USER_REJECTED' ? 'Wallet rejected' : `Transaction failed: ${status}` }; }

/** Stable business request IDs live in the bridge journal, not this app's memory.
 * Each scenario has fresh fixtures and its own journal. A production app must
 * scope these IDs to the actual order/ticket/customer, never a random retry ID.
 */
function createRecoverableTicketService(ledger) {
  const purchaseId = 'ticket:1:customer:purchase';
  const checkInId = 'ticket:1:customer:check-in';
  const execute = (requestId, operation) => ledger('/execute-once', { requestId, operation, retryFailed: true });
  const pending = label => ({ ok: false, pending: true, message: `${label} outcome pending; retry verification` });
  let queue = Promise.resolve();
  const handle = async action => {
    if (action === 'buy') {
      const association = await execute('ticket:customer:association', { type: 'associate', actor: 'customer', token: 'ticket' });
      if (association.status === 'PENDING') return pending('Purchase');
      if (!['SUCCESS', 'TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT'].includes(association.status)) return failure(association.status);
      const tx = await execute(purchaseId, { type: 'transferNft', actor: 'organizer', to: 'customer', token: 'ticket', serial: 1 });
      if (tx.status === 'PENDING') return pending('Purchase');
      return tx.status === 'SUCCESS' ? { ok: true, message: 'Ticket purchased', transactionId: tx.transactionId } : failure(tx.status);
    }
    if (action === 'check-in') {
      const purchase = await ledger('/receipt', { requestId: purchaseId });
      if (purchase?.status === 'PENDING') return pending('Purchase');
      if (purchase?.status !== 'SUCCESS') return { ok: false, message: 'Buy a ticket first' };
      const tx = await execute(checkInId, { type: 'submitMessage', actor: 'customer', topic: 'attendance', message: 'ticket:1:customer' });
      if (tx.status === 'PENDING') return pending('Check-in');
      return tx.status === 'SUCCESS' ? { ok: true, message: 'Checked in', transactionId: tx.transactionId } : failure(tx.status);
    }
    return { ok: false, message: 'Unknown action' };
  };
  return { handle(action) {
    const next = queue.then(() => handle(action));
    queue = next.catch(() => undefined);
    return next;
  } };
}
