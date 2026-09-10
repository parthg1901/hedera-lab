/** App behavior under test. Lab supplies a server-side transaction adapter. */
export function createTicketService(ledger) {
  let purchased = false;
  let checkedIn = false;
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
    const tx = await execute({ type: 'submitMessage', actor: 'customer', topic: 'attendance', message: 'ticket:1:customer' });
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
