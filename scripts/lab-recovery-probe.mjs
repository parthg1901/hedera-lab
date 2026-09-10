/** Reserve an ID without sending it, then exercise the adapter's real read path. */
export async function probeUnsubmittedReceipt({ ledger, api, transactionId }) {
  const requestId = "receipt-probe:unsubmitted";
  const operation = { type: "submitMessage", actor: "customer", topic: "attendance", message: "receipt-probe:must-not-be-submitted" };
  const execute = ledger.execute;
  let reserved = 0;
  ledger.execute = async (_operation, beforeSubmit) => {
    reserved++;
    await beforeSubmit(transactionId);
    throw Error("Injected stop after durable ID allocation, before network submission");
  };
  const requirePending = result => {
    if (result?.status !== "PENDING" || result.transactionId !== transactionId)
      throw Error("Unsubmitted request did not retain its original pending transaction ID");
  };
  try {
    requirePending(await api("/execute-once", { requestId, operation }));
    if (reserved !== 1) throw Error("Unsubmitted probe did not reserve exactly one ID");
  } finally { ledger.execute = execute; }

  const reconcile = ledger.reconcile;
  const observations = [];
  ledger.reconcile = async (...args) => {
    const result = await reconcile.apply(ledger, args);
    observations.push({ transactionId: args[0], found: result !== null });
    return result;
  };
  try {
    requirePending(await api("/receipt", { requestId }));
    requirePending(await api("/execute-once", { requestId, operation, retryFailed: true }));
    if (observations.length !== 2 || observations.some(row => row.transactionId !== transactionId || row.found))
      throw Error("Unsubmitted probe requires two missing results from the real reconciliation path");
  } finally { ledger.reconcile = reconcile; }
  return {
    requestId, transactionId,
    injection: "Persisted an SDK-generated ID but deliberately stopped before submission",
    reconciliation: "Unmodified adapter receipt/archive reads; no injected null results",
    observations,
    status: "PENDING",
  };
}
