import { importHieroSdk } from "../optionalDeps.js";
import { awaitReceipt } from "../lab/receipt.js";
import type { Auditor } from "./engine.js";
import type { Job, Quote } from "./model.js";
/** An HCS anchor proves publication/linkage, not the correctness of test execution. */
export class HcsAuditor implements Auditor {
  constructor(readonly topicId: string) {
    if (!/^0\.0\.\d+$/.test(topicId)) throw new Error("Invalid audit topic ID");
  }
  async record(job: Job, quote: Quote) {
    const sdk = await importHieroSdk();
    const account =
      process.env.VERIFIER_AUDIT_OPERATOR_ID ?? process.env.HEDERA_OPERATOR_ID;
    const raw =
      process.env.VERIFIER_AUDIT_OPERATOR_KEY ??
      process.env.HEDERA_OPERATOR_KEY;
    if (!account || !raw) throw new Error("Audit signing credentials missing");
    const client = sdk.Client.forTestnet()
      .setOperator(
        account,
        sdk.PrivateKey.fromStringECDSA(raw.replace(/^0x/, "")),
      )
      .setMaxAttempts(2);
    try {
      const tx = new sdk.TopicMessageSubmitTransaction()
        .setTopicId(this.topicId)
        .setMessage(
          JSON.stringify({
            schemaVersion: 1,
            type: "verification.evidence",
            jobId: job.id,
            quoteId: quote.id,
            contractHash: quote.contractHash,
            reportHash: job.reportHash,
            paymentTransaction: job.transaction,
          }),
        );
      const response = await tx.execute(client);
      await awaitReceipt(response, client);
      return {
        topicId: this.topicId,
        transactionId: response.transactionId.toString(),
      };
    } finally {
      client.close();
    }
  }
}
