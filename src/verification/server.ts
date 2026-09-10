import { fitExecutionExposure } from "./contracts.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { recommend, selectCoverage, validateChanges } from "./changes.js";
import { Exchange } from "./engine.js";
import { amount, Fault, hash, type Selection } from "./model.js";
import { dashboard } from "./ui.js";
const token = (req: IncomingMessage) =>
  (req.headers.authorization ?? "").replace(/^Bearer /, "");
async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const b of req) {
    size += b.length;
    if (size > 64_000) throw new Fault(413, "Request too large");
    parts.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString() || "{}");
  } catch {
    throw new Fault(400, "Invalid JSON");
  }
}
function send(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(data));
}
export function createExchangeServer(exchange: Exchange, adminToken: string) {
  if (adminToken.length < 24)
    throw new Error("Customer admin token must have at least 24 characters");
  return createServer(async (req, res) => {
    try {
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host)
          throw new Fault(403, "Cross-origin requests are not accepted");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;
      if (req.method === "GET" && route === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(dashboard);
        return;
      }
      if (req.method === "GET" && route === "/health") {
        send(res, 200, { ok: true, mode: exchange.payment.mode });
        return;
      }
      if (req.method === "GET" && route === "/catalog") {
        send(res, 200, {
          name: "Hedera Verifier Exchange",
          target: exchange.target,
          paymentMode: exchange.payment.mode,
          unit: "tinybar",
          capabilities: [
            "quote",
            "counteroffer",
            "budget-reservation",
            "x402",
            "independent-lab-evidence",
          ],
          packs: await exchange.catalog(),
        });
        return;
      }
      if (req.method === "POST" && route === "/mandates") {
        if (
          !timingSafeEqual(
            Buffer.from(hash(token(req))),
            Buffer.from(hash(adminToken)),
          )
        )
          throw new Fault(401, "Only the customer can authorize mandates");
        send(res, 201, await exchange.createMandate(await body(req)));
        return;
      }
      const mandate = route.match(/^\/mandates\/([\w-]+)$/);
      if (req.method === "GET" && mandate) {
        send(res, 200, await exchange.view(mandate[1], token(req)));
        return;
      }
      if (req.method === "POST" && route === "/recommendations") {
        const b = await body(req);
        const view = await exchange.view(b.mandateId, token(req));
        const eligible = new Set(
          (await exchange.catalog())
            .filter(
              (p) =>
                p.availability.available &&
                (
                  view.mandate.executionEnvironments ?? [
                    "simulated",
                    "mainnet-preflight",
                  ]
                ).includes(p.execution.environment),
            )
            .map((p) => p.id),
        );
        const assessment = recommend(
          exchange.packs.filter((p) => eligible.has(p.id)),
          view.mandate.required,
          validateChanges(b.changes),
        );
        const remaining =
          amount(view.mandate.ceiling) -
          amount(view.mandate.reserve) -
          amount(view.budget.spent) -
          amount(view.budget.reserved);
        const allocation =
          b.allocation === undefined ? remaining : amount(b.allocation);
        if (allocation > remaining)
          throw new Fault(400, "Allocation exceeds remaining mandate budget");
        const proposal = selectCoverage(
          assessment.recommendations,
          allocation.toString(),
        );
        proposal.selection = fitExecutionExposure(
          proposal.selection,
          view.mandate.required,
          await exchange.catalog(),
          view.executionAvailable,
        );
        proposal.price = proposal.selection
          .reduce(
            (n, s) =>
              n +
              amount(
                exchange.packs.find((p) => p.id === s.pack)!.priceTinybar,
              ) *
                BigInt(s.repetitions),
            0n,
          )
          .toString();
        proposal.rationale +=
          " Execution funding ceilings are enforced separately from service payment.";
        send(res, 200, {
          assessment,
          proposal,
          available: remaining.toString(),
        });
        return;
      }
      if (req.method === "POST" && route === "/quotes") {
        const b = await body(req);
        send(
          res,
          201,
          await exchange.quote(
            b.mandateId,
            token(req),
            b.selection as Selection[],
            b.parent,
            b.changes,
          ),
        );
        return;
      }
      const accept = route.match(/^\/quotes\/([\w-]+)\/accept$/);
      if (req.method === "POST" && accept) {
        send(res, 201, await exchange.accept(accept[1], token(req)));
        return;
      }
      const reconcile = route.match(/^\/jobs\/([\w-]+)\/reconcile$/);
      if (req.method === "POST" && reconcile) {
        if (
          !timingSafeEqual(
            Buffer.from(hash(token(req))),
            Buffer.from(hash(adminToken)),
          )
        )
          throw new Fault(
            401,
            "Reconciliation requires customer authorization",
          );
        send(res, 200, await exchange.reconcile(reconcile[1]));
        return;
      }
      const job = route.match(/^\/jobs\/([\w-]+)(?:\/(pay|cancel))?$/);
      if (job) {
        const j = await exchange.job(job[1], token(req));
        if (req.method === "GET" && !job[2]) {
          send(res, 200, j);
          return;
        }
        if (req.method === "POST" && job[2] === "cancel") {
          send(res, 200, await exchange.cancel(j.id, token(req)));
          return;
        }
        if (req.method === "POST" && job[2] === "pay") {
          if (
            ["paid", "running", "complete", "infrastructure_failed"].includes(
              j.state,
            )
          ) {
            send(res, 200, j);
            return;
          }
          const s = await exchange.store.read();
          const q = s.quotes[j.quoteId];
          const header =
            req.headers["payment-signature"] ?? req.headers["x-payment"];
          if (!header) {
            const requirements = await exchange.payment.requirements(q);
            const challenge =
              exchange.payment.mode === "simulated"
                ? requirements
                : {
                    x402Version: 2,
                    resource: {
                      url: route,
                      description:
                        "Execute the negotiated verification contract",
                      mimeType: "application/json",
                    },
                    accepts: [requirements],
                  };
            send(res, 402, challenge, {
              "payment-required": Buffer.from(
                JSON.stringify(challenge),
              ).toString("base64"),
            });
            return;
          }
          if (typeof header !== "string" || header.length > 48_000)
            throw new Fault(400, "Invalid payment header");
          let payload;
          try {
            payload = JSON.parse(Buffer.from(header, "base64").toString());
          } catch {
            throw new Fault(400, "Invalid payment encoding");
          }
          const result = await exchange.pay(j.id, token(req), payload);
          send(res, 202, result, {
            "payment-response": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: result.transaction,
                network:
                  exchange.payment.mode === "testnet"
                    ? "hedera:testnet"
                    : "simulated",
              }),
            ).toString("base64"),
          });
          return;
        }
      }
      throw new Fault(404, "Route not found");
    } catch (e) {
      send(res, e instanceof Fault ? e.status : 500, {
        error:
          e instanceof Fault
            ? e.message
            : "Service operation failed; inspect private operator logs",
      });
    }
  });
}
