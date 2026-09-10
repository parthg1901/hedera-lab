import { fitExecutionExposure } from "./contracts.js";
import { amount, type Selection } from "./model.js";
import { type ChangeSet } from "./changes.js";
import { codexPlan } from "./planner.js";
import { signPayment } from "./payment.js";
export function negotiate(
  packs: Array<{ id: string; priceTinybar: string }>,
  required: string[],
  available: string,
  initial: Selection[],
) {
  const selection = structuredClone(initial);
  const cost = () =>
    selection.reduce(
      (n, s) =>
        n +
        amount(packs.find((p) => p.id === s.pack)!.priceTinybar) *
          BigInt(s.repetitions),
      0n,
    );
  if (required.some((p) => !selection.some((s) => s.pack === p)))
    throw new Error("Proposal omits mandatory coverage");
  while (cost() > amount(available)) {
    const candidates = selection
      .filter((s) => s.repetitions > 1 || !required.includes(s.pack))
      .sort((a, b) =>
        Number(
          amount(packs.find((p) => p.id === b.pack)!.priceTinybar) -
            amount(packs.find((p) => p.id === a.pack)!.priceTinybar),
        ),
      );
    if (!candidates.length)
      throw new Error("Mandatory checks cannot fit the available budget");
    const item = candidates[0];
    if (item.repetitions > 1) item.repetitions--;
    else selection.splice(selection.indexOf(item), 1);
  }
  return {
    selection,
    price: cost().toString(),
    rationale:
      "Preserve required checks; reduce the most expensive repeated executions before removing optional packs. No change to customer requirements.",
  };
}
/** Deterministic purchasing agent. LLMs can call the same quote/counteroffer API. */
export async function runPurchaser(
  base: string,
  mandateId: string,
  token: string,
  options: {
    pay: boolean;
    planner?: "policy" | "codex";
    accountId?: string;
    privateKey?: string;
    repetitions?: number;
    changes?: ChangeSet;
    allocation?: string;
    onEvent?: (e: unknown) => void;
  },
) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Agent requires HTTPS except on loopback");
  const request = async (
    route: string,
    method = "GET",
    data?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(base + route, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(65_000),
    });
    const body = (await r.json()) as any;
    if (!r.ok) {
      const e = new Error(body.error ?? `HTTP ${r.status}`);
      Object.assign(e, { status: r.status, body });
      throw e;
    }
    return body;
  };
  const log = (e: unknown) => options.onEvent?.(e);
  const catalog = await request("/catalog"),
    view = await request(`/mandates/${mandateId}`);
  const remaining = (
    amount(view.mandate.ceiling) -
    amount(view.mandate.reserve) -
    amount(view.budget.spent) -
    amount(view.budget.reserved)
  ).toString();
  const available =
    options.allocation === undefined
      ? remaining
      : (amount(options.allocation) < amount(remaining)
          ? amount(options.allocation)
          : amount(remaining)
        ).toString();
  const recommendation = options.changes
    ? await request("/recommendations", "POST", {
        mandateId,
        changes: options.changes,
        allocation: available,
      })
    : undefined;
  if (recommendation)
    log({ type: "coverage_recommendation", ...recommendation });
  catalog.packs = catalog.packs.filter(
    (p: any) =>
      p.availability?.available !== false &&
      (!p.execution ||
        (
          view.mandate.executionEnvironments ?? [
            "simulated",
            "mainnet-preflight",
          ]
        ).includes(p.execution.environment)),
  );
  const initial = fitExecutionExposure(
    catalog.packs.map((p: any) => ({
      pack: p.id,
      repetitions: options.repetitions ?? 3,
    })),
    view.mandate.required,
    catalog.packs,
    view.executionAvailable ?? {},
  );
  const opening = await request("/quotes", "POST", {
    mandateId,
    selection: initial,
    changes: options.changes,
  });
  log({ type: "opening_quote", quote: opening });
  const decision =
    options.planner === "codex"
      ? await codexPlan({
          packs: catalog.packs,
          required: view.mandate.required,
          available,
          initial,
          openingPrice: opening.price,
          changes: options.changes,
          recommendations: recommendation?.assessment.recommendations,
        })
      : (recommendation?.proposal ??
        negotiate(catalog.packs, view.mandate.required, available, initial));
  log({ type: "counteroffer", ...decision, available });
  const quote = await request("/quotes", "POST", {
    mandateId,
    selection: decision.selection,
    parent: opening.id,
    changes: options.changes,
  });
  if (quote.price !== decision.price)
    throw new Error("Provider quote differs from catalog price");
  log({ type: "agreement", quote });
  if (!options.pay) return { quote, decision };
  const job = await request(`/quotes/${quote.id}/accept`, "POST", {});
  log({ type: "budget_reserved", jobId: job.id, price: quote.price });
  let challenge;
  try {
    await request(`/jobs/${job.id}/pay`, "POST", {});
    throw new Error("Expected payment challenge");
  } catch (e) {
    if ((e as any).status !== 402) throw e;
    challenge = (e as any).body;
  }
  let payload;
  if (catalog.paymentMode === "simulated") {
    if (challenge.simulation !== true)
      throw new Error("Invalid simulation challenge");
    payload = { simulation: true, quoteId: quote.id };
  } else {
    if (!options.accountId || !options.privateKey)
      throw new Error(
        "Testnet payment requires payer credentials; reservation can be cancelled or resumed through the API",
      );
    const requirement = challenge.accepts?.[0];
    if (
      !requirement ||
      requirement.amount !== quote.price ||
      requirement.extra?.contractHash !== quote.contractHash ||
      requirement.extra?.quoteId !== quote.id ||
      requirement.extra?.memo !== `verify:${quote.contractHash}`
    )
      throw new Error("Payment challenge does not match accepted quote");
    payload = await signPayment(
      requirement,
      options.accountId,
      options.privateKey,
    );
  }
  const paid = await request(
    `/jobs/${job.id}/pay`,
    "POST",
    {},
    {
      "payment-signature": Buffer.from(JSON.stringify(payload)).toString(
        "base64",
      ),
    },
  );
  log({
    type: "payment",
    jobId: job.id,
    transaction: paid.transaction,
    mode: catalog.paymentMode,
  });
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const result = await request(`/jobs/${job.id}`);
    if (
      [
        "complete",
        "infrastructure_failed",
        "payment_unknown",
        "payment_failed",
      ].includes(result.state)
    ) {
      log({ type: "delivery", job: result });
      return { quote, decision, job: result };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Job ${job.id} is still pending. Retrieve it; do not purchase again.`,
  );
}
