import type { Client, TransactionResponse, TransactionReceipt } from "@hiero-ledger/sdk";
/** Receipt polling is read-only and needs a larger budget than transaction submission.
 * Do not use response.getReceipt(): its throttling helper can resubmit writes.
 */
export async function awaitReceipt(response: TransactionResponse, client: Client): Promise<TransactionReceipt> {
  return response.getReceiptQuery(client).setMaxAttempts(30).setMaxBackoff(1000).execute(client);
}
